"""
Karaoke ingestion and processing pipeline.

This script automates playlist ingestion, duration/vocal filtering,
segment selection, loudness normalization, Demucs separation, loop-point
computation, and metadata persistence. It intentionally blocks uploads
while a track's `license_state` is not cleared.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import math
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import librosa
import numpy as np
import yt_dlp

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")


@dataclasses.dataclass
class PipelineConfig:
    playlist_url: str
    output_dir: Path
    min_duration: float = 40.0
    target_count: int = 200
    vocal_threshold: float = 0.35
    min_window: float = 40.0
    max_window: float = 60.0
    stride: float = 5.0
    crossfade_ms: float = 60.0
    license_state: str = "pending_clearance"
    upload_when_cleared: bool = True


@dataclasses.dataclass
class TrackCandidate:
    video_id: str
    title: str
    duration: float
    url: str
    license_state: str
    uploader: Optional[str] = None
    vocal_score: Optional[float] = None
    best_window: Optional[Tuple[float, float]] = None
    segment_path: Optional[Path] = None
    metadata: Dict[str, str] = dataclasses.field(default_factory=dict)


def fetch_playlist_entries(playlist_url: str, max_items: Optional[int] = None) -> List[Dict]:
    """Fetch metadata for a playlist without downloading media."""
    ydl_opts = {
        "quiet": True,
        "extract_flat": False,
        "skip_download": True,
        "noplaylist": False,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)
    entries = info.get("entries", [])
    if max_items:
        entries = entries[:max_items]
    logging.info("Fetched %s playlist entries", len(entries))
    return entries


def filter_candidates(entries: Sequence[Dict], min_duration: float, license_state: str) -> List[TrackCandidate]:
    candidates: List[TrackCandidate] = []
    for entry in entries:
        duration = entry.get("duration") or 0
        if duration < min_duration:
            continue
        candidates.append(
            TrackCandidate(
                video_id=entry.get("id", ""),
                title=entry.get("title", "untitled"),
                duration=float(duration),
                url=entry.get("url") or entry.get("webpage_url") or "",
                license_state=license_state,
                uploader=entry.get("uploader"),
            )
        )
    logging.info("Duration filter kept %s candidates", len(candidates))
    return candidates


def download_audio(url: str, output_dir: Path) -> Path:
    """Download bestaudio to a temporary WAV file using yt-dlp."""
    output_dir.mkdir(parents=True, exist_ok=True)
    temp_path = output_dir / "temp_audio.%(ext)s"
    ydl_opts = {
        "quiet": True,
        "format": "bestaudio/best",
        "outtmpl": str(temp_path),
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
                "preferredquality": "0",
            }
        ],
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    # Resolve the actual file path
    wav_files = list(output_dir.glob("temp_audio.*"))
    if not wav_files:
        raise FileNotFoundError("Audio download failed")
    return wav_files[0]


def score_vocal_presence(audio_path: Path) -> float:
    """Lightweight vocal presence score based on harmonic energy and spectral flatness."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    harmonic, percussive = librosa.effects.hpss(y)
    mel = librosa.feature.melspectrogram(harmonic, sr=sr, n_fft=2048, hop_length=512, fmin=150, fmax=5500)
    mel_db = librosa.power_to_db(mel)
    flatness = librosa.feature.spectral_flatness(S=mel)
    vocal_energy = np.exp(np.mean(mel_db) / 10.0)
    voicing = 1.0 - float(np.median(flatness))
    score = float(np.clip(vocal_energy * voicing, 0.0, 5.0))
    logging.debug("Vocal score: %.3f", score)
    return score


def locate_best_window(audio_path: Path, min_window: float, max_window: float, stride: float) -> Tuple[float, float, float]:
    """Return (start, duration, vocal_score) for the best window."""
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    hop = int(sr * stride)
    min_len = int(sr * min_window)
    max_len = int(sr * max_window)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
    times = librosa.frames_to_time(beats, sr=sr)

    best_score = -math.inf
    best_start = 0.0
    best_duration = min_window

    for start_sample in range(0, max(1, len(y) - min_len), hop):
        start_time = start_sample / sr
        max_end_sample = min(len(y), start_sample + max_len)
        segment = y[start_sample:max_end_sample]
        duration = len(segment) / sr
        if duration < min_window:
            continue
        harmonic, _ = librosa.effects.hpss(segment)
        vocal_energy = float(np.mean(np.abs(harmonic)))
        beat_bonus = 0.0
        for t in times:
            if start_time <= t <= start_time + duration:
                beat_bonus += 0.01
        score = vocal_energy + beat_bonus
        if score > best_score:
            best_score = score
            best_start = start_time
            best_duration = duration

    logging.info("Best window start=%.2fs duration=%.2fs score=%.3f", best_start, best_duration, best_score)
    return best_start, best_duration, best_score


def extract_segment_ffmpeg(source: Path, start: float, duration: float, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start}",
        "-i",
        str(source),
        "-t",
        f"{duration}",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    subprocess.run(cmd, check=True)


def normalize_loudness(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-af",
        "loudnorm=I=-14:TP=-1.5:LRA=11",
        str(destination),
    ]
    subprocess.run(cmd, check=True)


def run_demucs(audio: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["demucs", "--two-stems", "vocals", str(audio), "-o", str(output_dir)]
    subprocess.run(cmd, check=True)
    stem_dir = output_dir / "htdemucs" / audio.stem
    instrumental = stem_dir / "no_vocals.wav"
    if not instrumental.exists():
        raise FileNotFoundError("Demucs output not found")
    return instrumental


def compute_loop_points(segment_path: Path, crossfade_ms: float) -> Dict[str, float]:
    y, sr = librosa.load(segment_path, sr=None, mono=True)
    duration = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    if len(beats) >= 2:
        start = float(librosa.frames_to_time(beats[0], sr=sr))
        end = float(librosa.frames_to_time(beats[-1], sr=sr))
    else:
        start = 0.0
        end = max(0.0, duration - crossfade_ms / 1000.0)
    return {
        "loop_start": max(0.0, start),
        "loop_end": min(duration, end),
        "crossfade_ms": crossfade_ms,
        "bpm": float(tempo),
        "sample_rate": int(sr),
    }


def upload_to_storage(path: Path, destination: Path, license_state: str) -> None:
    if license_state != "cleared":
        logging.info("Skipping upload for %s because license_state=%s", path.name, license_state)
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(path, destination)
    logging.info("Uploaded %s to %s", path, destination)


def process_track(candidate: TrackCandidate, config: PipelineConfig) -> Optional[Dict]:
    logging.info("Processing %s", candidate.title)
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        downloaded = download_audio(candidate.url, tmp_path)
        candidate.vocal_score = score_vocal_presence(downloaded)
        if candidate.vocal_score < config.vocal_threshold:
            logging.info("Rejected %s due to low vocal score %.3f", candidate.title, candidate.vocal_score)
            return None

        start, duration, _ = locate_best_window(downloaded, config.min_window, config.max_window, config.stride)
        candidate.best_window = (start, duration)
        raw_segment = config.output_dir / "segments" / f"{candidate.video_id}_raw.wav"
        extract_segment_ffmpeg(downloaded, start, duration, raw_segment)

        normalized = config.output_dir / "segments" / f"{candidate.video_id}_normalized.wav"
        normalize_loudness(raw_segment, normalized)
        candidate.segment_path = normalized

        separated_dir = config.output_dir / "separations"
        instrumental = run_demucs(normalized, separated_dir)

        loop_meta = compute_loop_points(normalized, config.crossfade_ms)
        candidate.metadata = {
            "video_id": candidate.video_id,
            "title": candidate.title,
            "duration": candidate.duration,
            "vocal_score": candidate.vocal_score,
            "best_window_start": start,
            "best_window_duration": duration,
            "loop": loop_meta,
            "license_state": candidate.license_state,
        }

        meta_path = config.output_dir / "metadata" / f"{candidate.video_id}.json"
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(candidate.metadata, indent=2))

        upload_dest = config.output_dir / "upload" / f"{candidate.video_id}_loop.wav"
        upload_to_storage(instrumental, upload_dest, candidate.license_state)
        return candidate.metadata


def main() -> None:
    parser = argparse.ArgumentParser(description="Karaoke ingestion pipeline")
    parser.add_argument("playlist_url", help="YouTube playlist URL")
    parser.add_argument("--output", type=Path, default=Path("./data/pipeline_output"))
    parser.add_argument("--min-duration", type=float, default=40.0)
    parser.add_argument("--target-count", type=int, default=200)
    parser.add_argument("--vocal-threshold", type=float, default=0.35)
    parser.add_argument("--window", type=float, default=50.0)
    parser.add_argument("--stride", type=float, default=5.0)
    parser.add_argument("--crossfade-ms", type=float, default=60.0)
    parser.add_argument("--license-state", type=str, default="pending_clearance")
    args = parser.parse_args()

    config = PipelineConfig(
        playlist_url=args.playlist_url,
        output_dir=args.output,
        min_duration=args.min_duration,
        target_count=args.target_count,
        vocal_threshold=args.vocal_threshold,
        min_window=max(40.0, args.window - 10),
        max_window=min(60.0, args.window + 10),
        stride=args.stride,
        crossfade_ms=args.crossfade_ms,
        license_state=args.license_state,
    )

    entries = fetch_playlist_entries(config.playlist_url)
    candidates = filter_candidates(entries, config.min_duration, config.license_state)
    results: List[Dict] = []

    for candidate in candidates[: config.target_count]:
        metadata = process_track(candidate, config)
        if metadata:
            results.append(metadata)

    summary_path = config.output_dir / "metadata" / "summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(results, indent=2))
    logging.info("Pipeline complete. %s tracks processed.", len(results))


if __name__ == "__main__":
    main()
