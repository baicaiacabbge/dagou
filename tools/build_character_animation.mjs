#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(toolsDir);
const args = process.argv.slice(2);

function readArgument(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : fallback;
}

const sourceDirectory = readArgument('--source-directory');
if (!sourceDirectory) {
  throw new Error('请提供 --source-directory <序列帧目录>');
}

const sourceFps = Number(readArgument('--source-fps', '30'));
if (!Number.isFinite(sourceFps) || sourceFps < 1 || sourceFps > 120) {
  throw new Error('--source-fps 必须是 1–120 之间的数字');
}

const sourceFrames = fs.readdirSync(sourceDirectory)
  .filter((name) => /^dopnghaidihuang\d{3}\.png$/i.test(name));
if (sourceFrames.length < 108) {
  throw new Error(`序列帧不足：需要至少 108 帧，实际 ${sourceFrames.length} 帧`);
}
const atlasFrames = 108;
const lastSourceFrame = sourceFrames.length - 1;

const sourcePattern = path.join(sourceDirectory, 'dopnghaidihuang%03d.png');
const firstFrame = path.join(sourceDirectory, 'dopnghaidihuang000.png');
if (!fs.existsSync(firstFrame)) {
  throw new Error(`未找到序列帧：${sourcePattern}`);
}

const outputFile = path.resolve(
  readArgument(
    '--output',
    path.join(projectRoot, 'Image', 'donghaidihuang_atlas.webp'),
  ),
);
const iconOutputFile = path.resolve(
  readArgument(
    '--icon-output',
    path.join(projectRoot, 'Image', 'donghaidihuang_icon.webp'),
  ),
);
const result = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(sourceFps),
    '-start_number', '0',
    '-i', sourcePattern,
    '-vf',
    `select='eq(n,round(selected_n*${lastSourceFrame}/${atlasFrames - 1}))',` +
      'crop=672:960:636:100,' +
      'scale=360:514:flags=lanczos,format=bgra,' +
      'tile=12x9:nb_frames=108:padding=0:margin=0',
    '-frames:v', '1',
    '-c:v', 'libwebp',
    '-lossless', '1',
    '-quality', '100',
    '-preset', 'drawing',
    outputFile,
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`FFmpeg 压缩失败，退出码：${result.status}`);
}

const iconResult = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', firstFrame,
    '-vf', 'crop=600:600:710:100,scale=128:128:flags=lanczos,format=bgra',
    '-frames:v', '1',
    '-c:v', 'libwebp',
    '-lossless', '0',
    '-quality', '82',
    '-preset', 'icon',
    iconOutputFile,
  ],
  { stdio: 'inherit' },
);
if (iconResult.error) throw iconResult.error;
if (iconResult.status !== 0) {
  throw new Error(`FFmpeg 图标压缩失败，退出码：${iconResult.status}`);
}

const outputStat = fs.statSync(outputFile);
const iconStat = fs.statSync(iconOutputFile);
console.log(`图集：${outputFile}`);
console.log(`大小：${(outputStat.size / 1024 / 1024).toFixed(2)} MiB`);
console.log(`图标：${iconOutputFile}（${(iconStat.size / 1024).toFixed(1)} KiB）`);
