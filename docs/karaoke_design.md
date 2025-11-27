# Karaoke App Architecture and Pipeline

## Overview
This document outlines a legally aware karaoke experience built from the provided YouTube playlist. The design limits the catalog to 100–800 shorts vetted for clearance, loops 10–60s musical hooks, synchronizes lyrics, enables recording with effects and duet mode, supports sharing, and blocks distribution of any content lacking explicit rights.

## High-Level Architecture
```
+--------------------+     +-------------------+     +-----------------------+
|  Playlist Importer | --> | Ingestion Workers | --> |  Rights Management    |
|  (YouTube API)     |     | (audio, lyrics)   |     |  Service & Catalog DB |
+--------------------+     +-------------------+     +-----------------------+
          |                         |                          |
          v                         v                          v
+--------------------+     +-------------------+     +-----------------------+
| Media Storage (S3, | --> | Processing Queue  | --> |  Web/Mobile API       |
| GCS)               |     | (e.g., SQS)       |     |  (GraphQL/REST)       |
+--------------------+     +-------------------+     +-----------------------+
                                                              |
                                                              v
                                                +---------------------------+
                                                | Clients: Web, iOS, Android|
                                                | - Playback & Looping      |
                                                | - Recording & Effects     |
                                                | - Duet & Sharing          |
                                                +---------------------------+
```

### Key Services
- **Playlist Importer**: pulls metadata from the YouTube playlist, filters to legally cleared shorts (labels, CC BY licenses, or internal clearance list), and seeds ingestion jobs.
- **Ingestion Workers**: download audio, extract 10–60s hooks, generate seamless loops, align lyrics, normalize loudness, and export stems if available.
- **Rights Management Service**: maintains license proofs, flags non-cleared tracks, exposes gating APIs to prevent playback or sharing until cleared.
- **Media Storage**: stores original audio, processed loops, lyric files (LRC/WebVTT), and preview stems; versioned for auditability.
- **Web/Mobile API**: session-aware API enforcing rights checks before playback/recording/sharing; handles user recordings, effects presets, duet synchronization, and sharing links.

## Ingestion Pipeline (Playlist → Looping Clip)
1. **Discovery & Filtering**
   - Read playlist items with the YouTube Data API using the provided playlist ID.
   - Apply allowlist of 100–800 cleared shorts; reject items without license proof or with unverified rights.
   - Persist source metadata (video ID, title, channel, license text, duration, subtitle availability).

2. **Download & Compliance Checks**
   - Download audio via a licensed source (e.g., YouTube Content ID-cleared feed or provided masters) at highest available bitrate.
   - Verify checksum against trusted list; log provenance in the catalog DB.

3. **Segmentation & Hook Selection**
   - Detect beats and downbeats (e.g., `librosa.beat_track`) to find 10–60s musical hooks.
   - Choose loop points aligned to bars; ensure zero-crossing alignment to avoid clicks.
   - Compute LUFS and normalize to target (e.g., -14 LUFS) for consistent playback.

4. **Lyric Alignment**
   - Fetch timed lyrics from captions or external LRC provider; fall back to manual transcription when absent.
   - Align lyrics to audio using phoneme alignment (e.g., `aeneas` or `pydub + gentle`); export LRC and WebVTT for clients.

5. **Loop Rendering**
   - Render lossless master of the selected segment plus overlapping crossfade at loop boundaries (e.g., 50–150 ms) for seamless looping.
   - Generate compressed delivery formats (AAC/Opus) and waveform thumbnails for UX.

6. **Quality & Rights Gate**
   - Run automated QA (silence detection, phase cancellation, clipping checks, lyric timing drift) and store reports.
   - Block publication if any rights flag is raised or QA fails; require human sign-off.

7. **Publish to Catalog**
   - Store assets (audio loop, lyrics, metadata) with immutable content IDs.
   - Expose catalog entries via API with fields: `clearance_status`, `loop_start`, `loop_end`, `lyrics_uri`, `hashes`, `qa_score`.

## Sample Segmentation & Looping Code (Node.js)
```js
import ffmpeg from 'fluent-ffmpeg';
import { tmpdir } from 'os';
import path from 'path';

/**
 * Extract a loopable segment with fade handles and loudness normalization.
 * @param {string} inputPath - path to the source audio file
 * @param {number} startSec - loop start time in seconds
 * @param {number} durationSec - loop duration (10–60s)
 * @param {string} outPath - destination for the processed loop
 */
export async function makeLoop(inputPath, startSec, durationSec, outPath) {
  const fadeMs = 120; // overlap to smooth the loop
  const workFile = path.join(tmpdir(), `loop-${Date.now()}.wav`);

  // Step 1: cut the desired hook
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .duration(durationSec)
      .audioFilters([
        'loudnorm=I=-14:TP=-1.5:LRA=11', // normalize loudness
        `afade=t=in:ss=0:d=${fadeMs / 1000}`,
        `afade=t=out:st=${durationSec - fadeMs / 1000}:d=${fadeMs / 1000}`
      ])
      .output(workFile)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // Step 2: create a seamless loop by crossfading tail into head
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(workFile)
      .input(workFile)
      .complexFilter([
        {
          filter: 'acrossfade',
          options: { duration: fadeMs / 1000, curve1: 'tri', curve2: 'tri' }
        }
      ])
      .outputOptions('-map 0:a')
      .save(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}
```

## Rights Management Module
- **Catalog Tables**: `tracks` (metadata, loop points), `licenses` (type, expiry, proof URI), `clearance_status` (pending/cleared/restricted), `qa_reports` (signals).
- **APIs**
  - `GET /tracks` returns only cleared tracks for playback.
  - `POST /tracks/{id}/share` validates `clearance_status == cleared` and `qa_passed == true`; otherwise returns 403 with remediation steps.
  - `POST /tracks/{id}/flag` allows ops/legal to mark content; auto-unpublishes existing shares.
- **Client Enforcement**: player surfaces clearance badges; record/share buttons disabled unless the track is cleared.
- **Audit Trails**: every asset stores source hashes, license proof link, ingest operator, and QA verdict to enable re-verification.

## Client Experience Notes
- **Background Looping**: client prebuffers two loop copies and uses Web Audio `AudioBufferSourceNode` with scheduled start times for gapless playback.
- **Recording & Effects**: WebRTC getUserMedia + Web Audio for local monitoring; apply presets (reverb, autotune, EQ) via AudioWorklets; render mixdown server-side for share links.
- **Duet Mode**: latency-compensated metronome, guide vocal stem with adjustable gain, plus track-level latency calibration saved per device.
- **Sharing**: generates time-bound signed URLs referencing cleared assets; includes watermarking of mixed audio to discourage redistribution.

## QA Checklist (Licensing & Audio Quality)
**Licensing**
- [ ] License proof file or contract stored and linked in `licenses` table.
- [ ] Channel/label provided written clearance for karaoke use and sharing.
- [ ] Track status is `cleared`; otherwise player and sharing endpoints are blocked.
- [ ] Territory restrictions honored; geo blocks applied where required.
- [ ] Expiry dates monitored with alerts; expired items auto-unpublished.

**Audio & Lyrics Quality**
- [ ] Loop boundaries click-free (zero-crossing/crossfade verified).
- [ ] LUFS within ±1 dB of target; no clipping detected.
- [ ] Intro/outro trimmed; loop duration 10–60s inclusive.
- [ ] Lyrics synchronized within ±100 ms median offset; no missing lines.
- [ ] Stereo image preserved; phase correlation above 0.4; silence ratio < 5%.
- [ ] Background loop plays seamlessly for 5+ minutes without drift.
- [ ] Effect presets render without distortion at nominal gain.
- [ ] Duet alignment latency < 40 ms after calibration.
