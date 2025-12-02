"""
End-to-end automation script for ingesting the target YouTube playlist into a
short-segment karaoke catalog. The pipeline intentionally blocks distribution
until rights are cleared and emits rich metadata for QA.

Key steps
- Fetch playlist metadata with yt-dlp
- Enforce duration (>=40s) and vocal-presence filters
- Download audio and locate a 40–60s vocal-rich window
- Extract and loudness-normalize the segment
- Compute loop points with crossfade buffers
- Run Demucs separation + post-processing hooks
- Persist rights metadata (distribution is gated until cleared)
- Upload assets to storage (S3-compatible placeholder shown)

Dependencies are declared in `scripts/requirements-karaoke.txt`.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import soundfile as sf
import yt_dlp

try:
    import librosa
except ImportError as exc:  # pragma: no cover - helpful error for missing deps
    raise SystemExit(
        "librosa is required; install with `pip install -r scripts/requirements-karaoke.txt`"
    ) from exc

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL2vNBvHyEXihiuQ2htu6rLcOjw7lzsKcD"
TARGET_LUFS = -14.0
CROSSFADE_SECONDS = 0.15


@dataclass
class TrackMetadata:
    video_id: str
    title: str
    duration: float
    url: str
    uploader: Optional[str] = None
    license: Optional[str] = None


@dataclass
class SegmentMetadata:
    start: float
    end: float
    bpm: Optional[float]
    key: Optional[str]
    vocal_score: float
    loop_start: float
    loop_end: float
    crossfade: float


@dataclass
class SeparationResult:
    karaoke_bed: Path
    vocal_stem: Path
    sdr: Optional[float]
    sir: Optional[float]
    flagged: bool


@dataclass
class RightsMetadata:
    source: str
    video_id: str
    cleared: bool
    review_notes: str
    uploader: Optional[str] = None
    license: Optional[str] = None


def run_cmd(cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
    logger.debug("Running command: %s", " ".join(cmd))
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def fetch_playlist_metadata(playlist_url: str) -> List[TrackMetadata]:
    """Fetch playlist items without downloading media."""
    ydl_opts = {
        "extract_flat": True,
        "dump_single_json": True,
        "skip_download": True,
        "playlistend": 0,  # 0 == all entries
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)

    tracks: List[TrackMetadata] = []
    for entry in info.get("entries", []):
        if not entry:
            continue
        duration = float(entry.get("duration") or 0)
        tracks.append(
            TrackMetadata(
                video_id=entry.get("id"),
                title=entry.get("title", ""),
                duration=duration,
                url=entry.get("url") or f"https://www.youtube.com/watch?v={entry.get('id')}",
                uploader=entry.get("uploader"),
                license=entry.get("license"),
            )
        )
    logger.info("Fetched %d playlist entries", len(tracks))
    return tracks


def filter_by_duration(tracks: Iterable[TrackMetadata], min_seconds: float = 40.0) -> List[TrackMetadata]:
    items = list(tracks)
    filtered = [t for t in items if t.duration >= min_seconds]
    logger.info("Duration filter: kept %d/%d entries (>= %.1fs)", len(filtered), len(items), min_seconds)
    return filtered


def download_audio(track: TrackMetadata, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(out_dir / f"{track.video_id}.%(ext)s")
    ydl_opts = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": output_template,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([track.url])
    wav_path = out_dir / f"{track.video_id}.wav"
    logger.info("Downloaded audio to %s", wav_path)
    return wav_path


def vocal_presence_score(audio_path: Path, sr: int = 44100) -> float:
    """Compute a lightweight vocal-presence score using harmonic energy and spectral contrast."""
    y, _ = librosa.load(audio_path, sr=sr, mono=True)
    S_full, _ = librosa.magphase(librosa.stft(y))
    harmonic, percussive = librosa.decompose.hpss(S_full)
    spectral_contrast = librosa.feature.spectral_contrast(S=S_full)
    harmonic_energy = np.mean(harmonic)
    percussive_energy = np.mean(percussive)
    contrast_score = float(np.mean(spectral_contrast))
    ratio = harmonic_energy / (percussive_energy + 1e-9)
    score = float(np.tanh(0.5 * ratio + 0.001 * contrast_score))
    logger.debug("Vocal score %.3f for %s", score, audio_path)
    return score


def find_best_window(audio_path: Path, min_len: float = 40.0, max_len: float = 60.0, sr: int = 44100) -> SegmentMetadata:
    """Select the highest-scoring vocal-rich window and derive loop points."""
    y, _ = librosa.load(audio_path, sr=sr, mono=True)
    hop = int(sr * 0.5)
    window = int(sr * min_len)

    rms = librosa.feature.rms(y=y, frame_length=window, hop_length=hop)[0]
    vocal_scores = []
    for idx, _ in enumerate(rms):
        start = idx * hop
        end = start + window
        if end > len(y):
            break
        segment = y[start:end]
        spec = np.abs(librosa.stft(segment))
        harmonic, percussive = librosa.decompose.hpss(spec)
        ratio = float(np.mean(harmonic) / (np.mean(percussive) + 1e-9))
        vocal_scores.append((start / sr, min(max_len, len(segment) / sr), ratio))

    if not vocal_scores:
        raise RuntimeError("Unable to score vocal windows")

    best = max(vocal_scores, key=lambda x: x[2])
    start_sec, seg_len, vocal_score = best
    end_sec = start_sec + seg_len
    loop_start, loop_end = compute_loop_points(y, start_sec, end_sec, sr)

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    key = estimate_key(y, sr)

    return SegmentMetadata(
        start=start_sec,
        end=end_sec,
        bpm=float(tempo),
        key=key,
        vocal_score=vocal_score,
        loop_start=loop_start,
        loop_end=loop_end,
        crossfade=CROSSFADE_SECONDS,
    )


def estimate_key(y: np.ndarray, sr: int) -> Optional[str]:
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = np.mean(chroma, axis=1)
        pitch_classes = [
            "C",
            "C#",
            "D",
            "D#",
            "E",
            "F",
            "F#",
            "G",
            "G#",
            "A",
            "A#",
            "B",
        ]
        key_index = int(np.argmax(chroma_mean))
        return pitch_classes[key_index]
    except Exception:  # pragma: no cover - best effort helper
        return None


def compute_loop_points(y: np.ndarray, start_sec: float, end_sec: float, sr: int) -> Tuple[float, float]:
    start_sample = int(start_sec * sr)
    end_sample = int(end_sec * sr)
    segment = y[start_sample:end_sample]

    fade_len = int(CROSSFADE_SECONDS * sr)
    head = segment[:fade_len]
    tail = segment[-fade_len:]
    correlation = np.correlate(head, tail, mode="valid")
    offset = int(np.argmax(correlation))
    loop_start = start_sec + offset / sr
    loop_end = end_sec - CROSSFADE_SECONDS
    logger.debug("Loop points start=%.3f end=%.3f", loop_start, loop_end)
    return loop_start, loop_end


def extract_segment(audio_path: Path, segment: SegmentMetadata, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / f"{audio_path.stem}_segment.wav"
    duration = segment.end - segment.start
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        str(segment.start),
        "-i",
        str(audio_path),
        "-t",
        str(duration),
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    run_cmd(cmd)
    normalize_loudness(output_path)
    logger.info("Extracted loop-ready segment to %s", output_path)
    return output_path


def normalize_loudness(audio_path: Path) -> None:
    tmp = audio_path.with_suffix(".tmp.wav")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(audio_path),
        "-af",
        f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11",
        str(tmp),
    ]
    run_cmd(cmd)
    shutil.move(tmp, audio_path)


def run_demucs(audio_path: Path, out_dir: Path) -> SeparationResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["demucs", "--two-stems=vocals", str(audio_path), "-o", str(out_dir)]
    run_cmd(cmd)
    demucs_dir = out_dir / "htdemucs" / audio_path.stem
    karaoke_bed = demucs_dir / "no_vocals.wav"
    vocal_stem = demucs_dir / "vocals.wav"
    flagged = not karaoke_bed.exists() or not vocal_stem.exists()
    return SeparationResult(karaoke_bed=karaoke_bed, vocal_stem=vocal_stem, sdr=None, sir=None, flagged=flagged)


def write_rights_metadata(track: TrackMetadata, cleared: bool, reason: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    rights = RightsMetadata(
        source="YouTube",
        video_id=track.video_id,
        cleared=cleared,
        review_notes=reason,
        uploader=track.uploader,
        license=track.license,
    )
    rights_path = out_dir / f"{track.video_id}_rights.json"
    rights_path.write_text(json.dumps(asdict(rights), indent=2))
    return rights_path


def save_segment_metadata(track: TrackMetadata, segment: SegmentMetadata, separation: SeparationResult, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload: Dict[str, object] = {
        "track": asdict(track),
        "segment": asdict(segment),
        "separation": asdict(separation),
        "qa": {
            "loop_target_minutes": 5,
            "lyric_sync_tolerance_ms": 100,
            "tempo_variation": "±10%",
            "pitch_variation": "±2 semitones",
        },
        "distribution": {"cleared": False, "note": "Block distribution until license is cleared."},
    }
    meta_path = out_dir / f"{track.video_id}_segment.json"
    meta_path.write_text(json.dumps(payload, indent=2))
    return meta_path


def upload_to_storage(asset_dir: Path) -> None:
    """Placeholder for S3/GCS upload."""
    logger.info("Upload step placeholder: sync %s to object storage", asset_dir)


def process_track(track: TrackMetadata, work_dir: Path, score_threshold: float = 0.2) -> Optional[Path]:
    raw_dir = work_dir / "raw"
    segment_dir = work_dir / "segments"
    separation_dir = work_dir / "separation"
    metadata_dir = work_dir / "metadata"

    if track.duration < 40:
        logger.warning("Skipping %s (%s) because it is under 40s", track.title, track.video_id)
        write_rights_metadata(track, cleared=False, reason="duration_below_threshold", out_dir=metadata_dir)
        return None

    audio_path = download_audio(track, raw_dir)
    score = vocal_presence_score(audio_path)
    if score < score_threshold:
        logger.warning("Skipping %s (%s) due to low vocal presence score=%.3f", track.title, track.video_id, score)
        write_rights_metadata(track, cleared=False, reason="vocal_score_below_threshold", out_dir=metadata_dir)
        return None

    segment = find_best_window(audio_path)
    segment_path = extract_segment(audio_path, segment, segment_dir)
    separation = run_demucs(segment_path, separation_dir)
    meta_path = save_segment_metadata(track, segment, separation, metadata_dir)
    write_rights_metadata(track, cleared=False, reason="awaiting_rights_clearance", out_dir=metadata_dir)
    upload_to_storage(work_dir)
    return meta_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Karaoke ingestion + segmentation pipeline")
    parser.add_argument("--playlist", default=PLAYLIST_URL, help="YouTube playlist URL")
    parser.add_argument("--workdir", default="output", help="Working directory for assets")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of tracks (0 = all)")
    parser.add_argument("--score-threshold", type=float, default=0.2, help="Minimum vocal score")
    args = parser.parse_args()

    work_dir = Path(args.workdir)
    tracks = fetch_playlist_metadata(args.playlist)
    duration_filtered = [t for t in tracks if t.duration >= 40]
    if args.limit:
        duration_filtered = duration_filtered[: args.limit]

    processed = 0
    for track in duration_filtered:
        try:
            result = process_track(track, work_dir, score_threshold=args.score_threshold)
            if result:
                processed += 1
                logger.info("Processed %s -> %s", track.title, result)
        except Exception as exc:  # pragma: no cover - operational safeguard
            logger.exception("Failed to process %s: %s", track.video_id, exc)

    logger.info("Pipeline complete: %d tracks processed", processed)


if __name__ == "__main__":
    main()
