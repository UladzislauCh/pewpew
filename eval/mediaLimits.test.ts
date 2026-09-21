import { describe, expect, it } from 'vitest'
import {
  isAllowedAudioDeclaration,
  isAllowedVideoDeclaration,
  isAudioDurationAllowed,
  isAudioLayoutAllowed,
  isVideoDisplaySizeAllowed,
  isVideoDurationAllowed,
  MEDIA_LIMITS,
  sniffMediaBytes,
} from '../src/domain/video/mediaKind'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function asciiBytes(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0))
}

describe('sniffMediaBytes', () => {
  it('detects ISO BMFF (ftyp)', () => {
    const head = bytes(0, 0, 0, 0x18, ...asciiBytes('ftyp'), ...asciiBytes('isom'), 0, 0, 0, 0)
    expect(sniffMediaBytes(head)).toBe('isobmff')
  })

  it('detects WebM EBML', () => {
    expect(sniffMediaBytes(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('webm')
  })

  it('detects WAV', () => {
    const head = bytes(...asciiBytes('RIFF'), 0, 0, 0, 0, ...asciiBytes('WAVE'))
    expect(sniffMediaBytes(head)).toBe('wav')
  })

  it('detects Ogg and MP3', () => {
    expect(sniffMediaBytes(bytes(...asciiBytes('OggS'), 0, 0, 0, 0, 0, 0, 0, 0))).toBe('ogg')
    expect(sniffMediaBytes(bytes(...asciiBytes('ID3'), 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('mp3')
    expect(sniffMediaBytes(bytes(0xff, 0xfb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe('mp3')
  })
})

describe('declaration whitelist', () => {
  it('accepts known video extensions / MIME', () => {
    expect(isAllowedVideoDeclaration({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true)
    expect(isAllowedVideoDeclaration({ name: 'clip.mov', type: '' })).toBe(true)
    expect(isAllowedVideoDeclaration({ name: 'clip.webm', type: 'video/webm' })).toBe(true)
  })

  it('rejects unknown video types', () => {
    expect(isAllowedVideoDeclaration({ name: 'clip.avi', type: '' })).toBe(false)
    expect(isAllowedVideoDeclaration({ name: 'clip.mkv', type: 'video/x-matroska' })).toBe(false)
  })

  it('accepts known audio extensions / MIME', () => {
    expect(isAllowedAudioDeclaration({ name: 'hit.wav', type: '' })).toBe(true)
    expect(isAllowedAudioDeclaration({ name: 'hit.m4a', type: 'audio/mp4' })).toBe(true)
    expect(isAllowedAudioDeclaration({ name: 'hit.mp3', type: 'audio/mpeg' })).toBe(true)
  })

  it('rejects non-audio declarations', () => {
    expect(isAllowedAudioDeclaration({ name: 'clip.mp4', type: 'video/mp4' })).toBe(false)
    expect(isAllowedAudioDeclaration({ name: 'hit.flac', type: '' })).toBe(false)
  })
})

describe('meta validators', () => {
  it('enforces video duration and display size', () => {
    expect(isVideoDurationAllowed(MEDIA_LIMITS.video.maxDurationSec)).toBe(true)
    expect(isVideoDurationAllowed(MEDIA_LIMITS.video.maxDurationSec + 0.1)).toBe(false)
    expect(isVideoDisplaySizeAllowed(1920, 1080)).toBe(true)
    expect(isVideoDisplaySizeAllowed(1080, 1920)).toBe(true)
    expect(isVideoDisplaySizeAllowed(3840, 2160)).toBe(false)
  })

  it('enforces audio duration and layout', () => {
    expect(isAudioDurationAllowed(MEDIA_LIMITS.audio.maxDurationSec)).toBe(true)
    expect(isAudioDurationAllowed(MEDIA_LIMITS.audio.maxDurationSec + 1)).toBe(false)
    expect(isAudioLayoutAllowed(48_000, 2)).toBe(true)
    expect(isAudioLayoutAllowed(192_000, 2)).toBe(false)
    expect(isAudioLayoutAllowed(48_000, 8)).toBe(false)
  })
})
