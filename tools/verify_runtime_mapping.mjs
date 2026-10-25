#!/usr/bin/env node

// Executes the actual pitch-mapping declarations/functions extracted from
// main.js, then compares every fixed sample/tier rate with the analyzer report.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolsDir);
const mainPath = path.join(rootDir, 'main.js');
const audioDataPath = path.join(rootDir, 'audio-data.js');
const reportPath = path.join(toolsDir, 'tmp', 'pitch-analysis-report.json');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const sampleNames = [
  'da', 'gou', 'jiao',
  'ha', 'ji', 'mi',
  'dingdongji_ding', 'dingdongji_dong', 'dingdongji_ji',
];
const runtimeSampleFiles = {
  da: 'da.wav',
  gou: 'gou.wav',
  jiao: 'jiao.wav',
  ha: 'ha_new.wav',
  ji: 'ji_new.wav',
  mi: 'mi_new.wav',
  dingdongji_ding: 'dingdongji_ding.wav',
  dingdongji_dong: 'dingdongji_dong.wav',
  dingdongji_ji: 'dingdongji_ji.wav',
};

function extractDeclaration(pattern, label) {
  const match = mainSource.match(pattern);
  if (!match) throw new Error(`Cannot find ${label} in main.js`);
  return match[0];
}

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Cannot find function ${name} in main.js`);
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index++) {
    if (mainSource[index] === '{') depth++;
    if (mainSource[index] === '}') {
      depth--;
      if (depth === 0) return mainSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function ${name} in main.js`);
}

const declarations = [
  extractDeclaration(/const PIANO_OCTAVE_MIN = \d+;/, 'PIANO_OCTAVE_MIN'),
  extractDeclaration(/const PIANO_OCTAVE_MAX = \d+;/, 'PIANO_OCTAVE_MAX'),
  extractDeclaration(
    /const PIANO_DEFAULT_OCTAVE_START = \d+;/,
    'PIANO_DEFAULT_OCTAVE_START',
  ),
  extractDeclaration(
    /const SUSTAIN_REGIONS = \{[\s\S]*?\n\};/,
    'SUSTAIN_REGIONS',
  ),
  extractDeclaration(
    /const SFX_SAMPLE_SETS = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'SFX_SAMPLE_SETS',
  ),
  extractDeclaration(
    /const BARK_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const BARK_NORMAL_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_NORMAL_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const BARK_PIANO_SOURCE_MIDI = Object\.freeze\(\{[\s\S]*?\}\);/,
    'BARK_PIANO_SOURCE_MIDI',
  ),
  extractDeclaration(
    /const BARK_TARGET_MIDI = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'BARK_TARGET_MIDI',
  ),
  extractDeclaration(
    /const PIANO_SCALE_INTERVALS = Object\.freeze\(\[[^\n]+\);/,
    'PIANO_SCALE_INTERVALS',
  ),
  extractDeclaration(
    /const PIANO_SCALE_NOTES = Object\.freeze\(\[[^\n]+\);/,
    'PIANO_SCALE_NOTES',
  ),
  extractDeclaration(
    /const PIANO_SCALE_SOLFEGE = Object\.freeze\(\[[^\n]+\);/,
    'PIANO_SCALE_SOLFEGE',
  ),
  extractDeclaration(
    /const SFX_SAMPLE_GAIN = Object\.freeze\(\{[\s\S]*?\n\}\);/,
    'SFX_SAMPLE_GAIN',
  ),
].join('\n');

const runtimeRateFunction = extractFunction('barkPlaybackRate');
const resolveSfxSampleFunction = extractFunction('resolveSfxSample');
if (!/^function barkPlaybackRate\(sample, pitchTier, fixedTargetMidi, pianoOctaveStart\)/.test(runtimeRateFunction)) {
  throw new Error('barkPlaybackRate must accept target MIDI and piano octave overrides');
}

const sandbox = {};
vm.runInNewContext(
  `
  let cols = 4;
  let rows = 3;
  let zones = [];
  let selectedSfxId = 'dagou';
  const performanceSettings = {
    pianoMode: false,
    octaveSwitching: false,
    pianoOctaveStart: 4,
  };
  let stageMetrics = { width: 1200, height: 800 };
  function getStageMetrics() { return stageMetrics; }
  function renderOctaveControls() {}
  ${declarations}
  ${extractFunction('normalizePianoOctaveStart')}
  ${extractFunction('effectivePianoOctaveStart')}
  ${extractFunction('buildPianoScale')}
  ${runtimeRateFunction}
  ${resolveSfxSampleFunction}
  ${extractFunction('buildGrid')}
  globalThis.mappingApi = {
    barkPlaybackRate,
    sustainRegions: SUSTAIN_REGIONS,
    sourceMidi: BARK_SOURCE_MIDI,
    normalSourceMidi: BARK_NORMAL_SOURCE_MIDI,
    pianoSourceMidi: BARK_PIANO_SOURCE_MIDI,
    targetMidi: BARK_TARGET_MIDI,
    buildPianoScale,
    sampleGain: SFX_SAMPLE_GAIN,
    resolveSfxSample,
    buildLayout(
      width,
      height,
      pianoMode = false,
      octaveSwitching = false,
      pianoOctaveStart = PIANO_DEFAULT_OCTAVE_START,
    ) {
      stageMetrics = { width, height };
      performanceSettings.pianoMode = pianoMode;
      performanceSettings.octaveSwitching = octaveSwitching;
      performanceSettings.pianoOctaveStart = pianoOctaveStart;
      buildGrid();
      return {
        cols,
        rows,
        zones: zones.map(zone => ({ ...zone })),
      };
    },
  };
  `,
  sandbox,
);

const { mappingApi } = sandbox;
const expectedSfxSamples = {
  hajimi: { da: 'ha', gou: 'ji', jiao: 'mi' },
  dingdong: {
    da: 'dingdongji_ding',
    gou: 'dingdongji_dong',
    jiao: 'dingdongji_ji',
  },
};
const analysedMiSustain = report.sustain_regions?.mi;
if (!analysedMiSustain?.config) {
  throw new Error('Pitch analyzer report is missing the mi sustain-region audit');
}
for (const [key, expected] of Object.entries(analysedMiSustain.config)) {
  if (mappingApi.sustainRegions.mi?.[key] !== expected) {
    throw new Error(
      `mi sustain ${key}: expected ${expected}, got ` +
      `${mappingApi.sustainRegions.mi?.[key]}`,
    );
  }
}
if (
  analysedMiSustain.pitch_span_cents > 30 ||
  analysedMiSustain.rms_span_db > 4 ||
  analysedMiSustain.minimum_confidence < 0.8
) {
  throw new Error('mi sustain region is not stable enough for WSOLA looping');
}
for (const [sfxId, expectedSamples] of Object.entries(expectedSfxSamples)) {
  for (const [semanticSample, audioSample] of Object.entries(expectedSamples)) {
    if (mappingApi.resolveSfxSample(semanticSample, sfxId) !== audioSample) {
      throw new Error(`${sfxId} ${semanticSample} must resolve to ${audioSample}`);
    }
    if (mappingApi.resolveSfxSample(semanticSample, 'dagou') !== semanticSample) {
      throw new Error(`Dagou ${semanticSample} must remain unchanged`);
    }
  }
}

const audioSandbox = {};
vm.runInNewContext(
  fs.readFileSync(audioDataPath, 'utf8').replace(
    'const AUDIO_B64',
    'globalThis.AUDIO_B64',
  ),
  audioSandbox,
);
for (const sample of sampleNames) {
  if (!audioSandbox.AUDIO_B64?.[sample]) {
    throw new Error(`Embedded audio bundle is missing ${sample}`);
  }
  const runtimeFile = path.join(
    rootDir,
    'audio',
    ...runtimeSampleFiles[sample].split('/'),
  );
  const embedded = Buffer.from(audioSandbox.AUDIO_B64[sample], 'base64');
  if (!embedded.equals(fs.readFileSync(runtimeFile))) {
    throw new Error(`Embedded ${sample} does not match ${runtimeSampleFiles[sample]}`);
  }
}

let checked = 0;
if (!Array.isArray(report.mappings) || report.mappings.length !== 36) {
  throw new Error('Pitch analyzer report must contain all 36 normal sample/tier mappings');
}
for (const mapping of report.mappings) {
  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.sample}/${mapping.tier}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
  // Repeated calls must never alter a key's pitch.
  const repeatedRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.tier_index,
  );
  if (repeatedRate !== actualRate) {
    throw new Error(`${mapping.sample}/${mapping.tier}: rate is not stable`);
  }
  checked++;
}

const minorPentatonicPitchClasses = new Set([9, 0, 2, 4, 7]);
const expectedRaisedHajimiTargets = {
  ha: [81, 79, 76, 72],
  ji: [74, 72, 69, 67],
  mi: [72, 69, 67, 64],
};
for (const sample of sampleNames) {
  const rows = report.mappings
    .filter(item => item.sample === sample)
    .sort((left, right) => left.tier_index - right.tier_index);
  if (rows.length !== 4) {
    throw new Error(`${sample}: expected four fixed pitch keys`);
  }
  for (const row of rows) {
    if (!minorPentatonicPitchClasses.has(row.target_midi % 12)) {
      throw new Error(`${sample}/${row.tier}: target is outside A minor pentatonic`);
    }
    if (mappingApi.targetMidi[sample][row.tier_index] !== row.target_midi) {
      throw new Error(`${sample}/${row.tier}: runtime target MIDI mismatch`);
    }
  }

  const sourceMidi = mappingApi.sourceMidi[sample];
  const candidates = [];
  for (let midi = 24; midi <= 108; midi++) {
    if (minorPentatonicPitchClasses.has(midi % 12)) candidates.push(midi);
  }
  const nearest = candidates.reduce((best, midi) =>
    Math.abs(midi - sourceMidi) < Math.abs(best - sourceMidi) ? midi : best
  );
  const nearestTier = report.method.nearest_minor_tier_index_by_sample?.[sample];
  if (!Number.isInteger(nearestTier) || rows[nearestTier].target_midi !== nearest) {
    throw new Error(
      `${sample}: tier ${nearestTier + 1} is ` +
      `${rows[nearestTier]?.target_midi}, nearest minor note is ${nearest}`,
    );
  }

  if (expectedRaisedHajimiTargets[sample]) {
    const actualTargets = rows.map(row => row.target_midi);
    if (
      actualTargets.some(
        (target, index) => target !== expectedRaisedHajimiTargets[sample][index],
      )
    ) {
      throw new Error(`${sample}: raised Hajimi target sequence is incorrect`);
    }
  }
}

const landscape = mappingApi.buildLayout(1200, 800);
if (landscape.cols !== 4 || landscape.rows !== 3) {
  throw new Error('Landscape grid is not 4 columns × 3 rows');
}
for (let row = 0; row < 3; row++) {
  const rowZones = landscape.zones.slice(row * 4, row * 4 + 4);
  if (rowZones.some((zone, column) => zone.pitchTier !== column)) {
    throw new Error(`Landscape row ${row}: pitch tiers do not run 0,1,2,3`);
  }
}

const portrait = mappingApi.buildLayout(800, 1200);
if (portrait.cols !== 3 || portrait.rows !== 4) {
  throw new Error('Portrait grid is not 3 columns × 4 rows');
}
for (let row = 0; row < 4; row++) {
  const rowZones = portrait.zones.slice(row * 3, row * 3 + 3);
  if (rowZones.some(zone => zone.pitchTier !== row)) {
    throw new Error(`Portrait row ${row}: pitch tier does not match row`);
  }
}

const pianoOctaveStarts = [3, 4, 5, 6];
const pianoIntervals = [0, 2, 4, 5, 7, 9, 11, 12];
const pianoMidiForOctave = octave =>
  pianoIntervals.map(interval => (octave + 1) * 12 + interval);
if (!Array.isArray(report.piano_mappings) || report.piano_mappings.length !== 288) {
  throw new Error('Pitch analyzer report must contain all 288 piano sample/key mappings');
}
for (const mapping of report.piano_mappings) {
  const pianoMidi = pianoMidiForOctave(mapping.octave_start);
  if (pianoMidi[mapping.key_index] !== mapping.target_midi) {
    throw new Error(`${mapping.sample}/piano-${mapping.key_index}: report target mismatch`);
  }
  if (mappingApi.buildPianoScale(mapping.octave_start)[mapping.key_index].midi !== mapping.target_midi) {
    throw new Error(`${mapping.sample}/piano-${mapping.key_index}: runtime scale mismatch`);
  }
  const actualRate = mappingApi.barkPlaybackRate(
    mapping.sample,
    mapping.key_index,
    mapping.target_midi,
    mapping.octave_start,
  );
  if (Math.abs(actualRate - mapping.playback_rate) > 1e-10) {
    throw new Error(
      `${mapping.sample}/piano-${mapping.key_index}: ` +
      `expected ${mapping.playback_rate}, got ${actualRate}`,
    );
  }
}

for (const octaveStart of pianoOctaveStarts) {
  const pianoMidi = pianoMidiForOctave(octaveStart);
  const pianoLandscape = mappingApi.buildLayout(
    1200,
    800,
    true,
    true,
    octaveStart,
  );
  if (pianoLandscape.cols !== 8 || pianoLandscape.rows !== 3) {
    throw new Error('Piano landscape grid is not 8 columns × 3 rows');
  }
  for (let row = 0; row < 3; row++) {
    const rowZones = pianoLandscape.zones.slice(row * 8, row * 8 + 8);
    const actualMidi = rowZones.map(zone => zone.targetMidi);
    if (actualMidi.some((midi, index) => midi !== pianoMidi[index])) {
      throw new Error(`Piano landscape C${octaveStart} row ${row} order is incorrect`);
    }
    const expectedSample = ['da', 'gou', 'jiao'][row];
    if (rowZones.some(zone => zone.sample !== expectedSample)) {
      throw new Error(`Piano landscape row ${row}: sample mapping is incorrect`);
    }
  }

  const pianoPortrait = mappingApi.buildLayout(
    800,
    1200,
    true,
    true,
    octaveStart,
  );
  if (pianoPortrait.cols !== 3 || pianoPortrait.rows !== 8) {
    throw new Error('Piano portrait grid is not 3 columns × 8 rows');
  }
  for (let row = 0; row < 8; row++) {
    const rowZones = pianoPortrait.zones.slice(row * 3, row * 3 + 3);
    const expectedMidi = pianoMidi[7 - row];
    if (rowZones.some(zone => zone.targetMidi !== expectedMidi)) {
      throw new Error(`Piano portrait C${octaveStart} row ${row} pitch is incorrect`);
    }
    if (rowZones.some((zone, column) => zone.sample !== ['da', 'gou', 'jiao'][column])) {
      throw new Error(`Piano portrait row ${row}: sample mapping is incorrect`);
    }
  }
}

const controlsDisabledLayout = mappingApi.buildLayout(1200, 800, true, false, 6);
const defaultPianoMidi = pianoMidiForOctave(4);
if (controlsDisabledLayout.zones.some(
  (zone, index) => zone.targetMidi !== defaultPianoMidi[index % 8],
)) {
  throw new Error('Disabled octave switching must retain the C4–C5 piano scale');
}

for (const sample of sampleNames) {
  const expectedGain = report.loudness?.sample_gain?.[sample];
  if (!Number.isFinite(expectedGain)) {
    throw new Error(`${sample}: analyzer report is missing loudness gain`);
  }
  if (Math.abs(mappingApi.sampleGain[sample] - expectedGain) > 1e-9) {
    throw new Error(
      `${sample}: expected loudness gain ${expectedGain}, ` +
      `got ${mappingApi.sampleGain[sample]}`,
    );
  }
}
if (report.worst_transposed_loudness_error_db > 1) {
  throw new Error('Normal-mode loudness calibration exceeds 1 dB');
}
const directPitchExceptions = new Set(['mi:6', 'dingdongji_ji:6']);
const pianoPitchOutliers = report.piano_mappings.filter(
  mapping => Math.abs(mapping.target_error_cents) > 25,
);
if (pianoPitchOutliers.some(mapping =>
  !directPitchExceptions.has(`${mapping.sample}:${mapping.octave_start}`) ||
  Math.abs(mapping.target_error_cents) > 35
)) {
  throw new Error('Piano pitch calibration has an unexpected >25-cent outlier');
}
for (const exception of directPitchExceptions) {
  if (!pianoPitchOutliers.some(mapping =>
    `${mapping.sample}:${mapping.octave_start}` === exception
  )) {
    throw new Error(`${exception}: documented direct-pitch exception is no longer present`);
  }
}

const pianoLoudnessOutliers = report.piano_mappings.filter(
  mapping => Math.abs(mapping.loudness_error_db) > 1,
);
if (
  pianoLoudnessOutliers.length !== 1 ||
  pianoLoudnessOutliers[0].sample !== 'gou' ||
  pianoLoudnessOutliers[0].octave_start !== 6 ||
  Math.abs(pianoLoudnessOutliers[0].loudness_error_db) > 1.2
) {
  throw new Error('Piano-mode loudness calibration has an unexpected >1 dB outlier');
}

console.log(`Runtime fixed pitch mapping verified: ${checked} sample/tier keys`);
console.log('SFX routing verified: Hajimi and Dingdong replace all three samples');
console.log('Embedded audio verified: all nine runtime WAV files are present');
console.log(
  `Hajimi mi sustain verified: ` +
  `${analysedMiSustain.pitch_span_cents.toFixed(3)} cents pitch span, ` +
  `${analysedMiSustain.rms_span_db.toFixed(3)} dB level span`,
);
console.log('Repeated-key pitch stability verified: no chord/time-dependent switching');
console.log('Layout verified: all four fixed pitch tiers retain their screen order');
console.log('Raised Hajimi verified: lowest tier removed and new high tier added');
console.log('Piano layout verified: four C3–C7 ranges in 8 × 3 / reversed 3 × 8 layouts');
console.log(
  `Worst remeasured transposed error: ` +
  `${report.worst_transposed_target_error_cents.toFixed(3)} cents`,
);
console.log(
  `Worst remeasured piano error: ` +
  `${report.worst_piano_target_error_cents.toFixed(3)} cents`,
);
console.log(
  `Worst calibrated loudness error: ` +
  `${Math.max(
    report.worst_transposed_loudness_error_db,
    report.worst_piano_loudness_error_db,
  ).toFixed(3)} dB`,
);
console.log(
  'Direct-pitch extremes documented: only mi/C6 and dingdongji_ji/C6 exceed 25 cents; ' +
  'only gou/C6 exceeds 1 dB',
);
