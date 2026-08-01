'use strict';

const OFFICIAL_URL = 'https://idolmaster-official.jp/serial-code';
const OCR_LANGUAGE = 'eng';
const MAX_IMAGE_EDGE = 1800;

const imageInput = document.getElementById('image-input');
const workPanel = document.getElementById('work-panel');
const preview = document.getElementById('preview');
const statusBox = document.getElementById('status-box');
const statusText = document.getElementById('status-text');
const progress = document.getElementById('progress');
const serialResult = document.getElementById('serial-result');
const validationMessage = document.getElementById('validation-message');
const copyButton = document.getElementById('copy-button');
const copyOpenButton = document.getElementById('copy-open-button');
const retryButton = document.getElementById('retry-button');
const processingCanvas = document.getElementById('processing-canvas');

let previewUrl = null;
let busy = false;

function setStatus(message, percent = 0) {
  statusText.textContent = message;
  progress.value = Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeSerial(value) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return compact.replace(/(.{4})(?=.)/g, '$1 ');
}

function compactSerial(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function scoreCandidate(candidate, context) {
  let score = 0;
  if (candidate.length === 16) score += 100;
  if (/[A-Z]/.test(candidate) && /\d/.test(candidate)) score += 15;
  if (/serial|シリアル/i.test(context)) score += 8;
  if (/^[A-Z0-9]+$/.test(candidate)) score += 5;
  return score;
}

function extractBestSerial(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [];

  for (const line of lines) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (compact.length >= 16) {
      for (let start = 0; start <= compact.length - 16; start += 1) {
        const value = compact.slice(start, start + 16);
        candidates.push({ value, score: scoreCandidate(value, line) });
      }
    }
  }

  const whole = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (whole.length >= 16) {
    for (let start = 0; start <= whole.length - 16; start += 1) {
      const value = whole.slice(start, start + 16);
      candidates.push({ value, score: scoreCandidate(value, rawText) - 5 });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value ?? '';
}

function updateValidation() {
  const compact = compactSerial(serialResult.value);
  serialResult.value = normalizeSerial(serialResult.value);
  const valid = compact.length === 16;

  validationMessage.textContent = valid
    ? '16文字です。写真と見比べて、読み取り結果を確認してください。'
    : `現在 ${compact.length} 文字です。16文字の英数字にしてください。`;
  validationMessage.classList.toggle('valid', valid);
  copyButton.disabled = !valid || busy;
  copyOpenButton.disabled = !valid || busy;
  return valid;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
      image.src = url;
    });
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function prepareCanvas(image) {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  processingCanvas.width = width;
  processingCanvas.height = height;
  const ctx = processingCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画像処理を開始できませんでした。');

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }

  ctx.putImageData(imageData, 0, 0);
  return processingCanvas;
}

async function recognizeSerial(image) {
  if (!window.Tesseract) {
    throw new Error('OCR機能を読み込めませんでした。通信状態を確認して再読み込みしてください。');
  }

  const canvas = prepareCanvas(image);
  const result = await window.Tesseract.recognize(canvas, OCR_LANGUAGE, {
    logger(message) {
      const percent = typeof message.progress === 'number' ? message.progress * 100 : 0;
      const labels = {
        'loading tesseract core': '読み取り機能を準備しています',
        'initializing tesseract': '読み取り機能を初期化しています',
        'loading language traineddata': '文字データを読み込んでいます',
        'initializing api': '文字認識を準備しています',
        'recognizing text': '写真から文字を読み取っています',
      };
      setStatus(labels[message.status] ?? '読み取り中です', percent);
    },
  });

  return extractBestSerial(result.data.text ?? '');
}

async function handleImage(file) {
  if (busy || !file) return;
  if (!file.type.startsWith('image/')) {
    window.alert('画像ファイルを選んでください。');
    return;
  }

  busy = true;
  serialResult.value = '';
  workPanel.hidden = false;
  statusBox.hidden = false;
  setStatus('写真を読み込んでいます', 2);
  updateValidation();
  workPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const loaded = await loadImage(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = loaded.url;
    preview.src = previewUrl;

    const serial = await recognizeSerial(loaded.image);
    serialResult.value = normalizeSerial(serial);
    setStatus(
      serial.length === 16
        ? '読み取りが終わりました'
        : '16文字のコードを確定できませんでした。手入力で修正してください。',
      100,
    );
    updateValidation();
    serialResult.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : '読み取りに失敗しました。', 0);
    window.alert('読み取りに失敗しました。写真を撮り直すか、結果欄へ手入力してください。');
  } finally {
    busy = false;
    updateValidation();
  }
}

async function copySerial() {
  if (!updateValidation()) return false;
  const text = serialResult.value;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    serialResult.select();
    const copied = document.execCommand('copy');
    serialResult.setSelectionRange(text.length, text.length);
    if (!copied) throw new Error('コピーできませんでした。');
  }

  setStatus('シリアルコードをコピーしました', 100);
  return true;
}

imageInput.addEventListener('change', () => {
  const [file] = imageInput.files ?? [];
  void handleImage(file);
});

serialResult.addEventListener('input', updateValidation);
serialResult.addEventListener('blur', () => {
  serialResult.value = normalizeSerial(serialResult.value);
  updateValidation();
});

copyButton.addEventListener('click', async () => {
  try {
    await copySerial();
  } catch {
    window.alert('コピーできませんでした。文字列を長押ししてコピーしてください。');
  }
});

copyOpenButton.addEventListener('click', async () => {
  try {
    if (await copySerial()) window.location.assign(OFFICIAL_URL);
  } catch {
    window.alert('コピーできませんでした。文字列を長押ししてコピーしてください。');
  }
});

retryButton.addEventListener('click', () => {
  imageInput.value = '';
  imageInput.click();
});

window.addEventListener('pagehide', () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

updateValidation();
