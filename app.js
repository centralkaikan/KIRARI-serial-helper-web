'use strict';

const OFFICIAL_URL = 'https://idolmaster-official.jp/serial-code';
const OCR_LANGUAGE = 'eng';
const MAX_OCR_EDGE = 2200;
const MAX_STORED_EDGE = 1200;
const DB_NAME = 'kirari-serial-helper-web';
const DB_VERSION = 1;
const STORE_NAME = 'history';

const imageInput = document.getElementById('image-input');
const statusBox = document.getElementById('status-box');
const statusText = document.getElementById('status-text');
const progress = document.getElementById('progress');
const historyList = document.getElementById('history-list');
const emptyState = document.getElementById('empty-state');
const historyCount = document.getElementById('history-count');
const deleteAllButton = document.getElementById('delete-all-button');
const processingCanvas = document.getElementById('processing-canvas');
const storageCanvas = document.getElementById('storage-canvas');

let busy = false;
let items = [];
let dbPromise = null;
const objectUrls = new Map();

function setStatus(message, percent = 0, visible = true) {
  statusBox.hidden = !visible;
  statusText.textContent = message;
  progress.value = Math.max(0, Math.min(100, Math.round(percent)));
}

function compactSerial(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatSerial(value) {
  return compactSerial(value).slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');
}

function isValidSerial(value) {
  const compact = compactSerial(value);
  return compact.length === 16 && /[A-Z]/.test(compact) && /\d/.test(compact);
}

function openDatabase() {
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('このブラウザでは履歴保存を利用できません。'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('履歴保存を開始できませんでした。'));
  });

  return dbPromise;
}

async function readAllItems() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error ?? new Error('履歴を読み込めませんでした。'));
  });
}

async function saveItem(item) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error ?? new Error('履歴を保存できませんでした。'));
    tx.onabort = () => reject(tx.error ?? new Error('履歴保存が中断されました。'));
  });
}

async function deleteItemFromDb(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error ?? new Error('履歴を削除できませんでした。'));
  });
}

async function clearDatabase() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error ?? new Error('履歴を削除できませんでした。'));
  });
}

function revokeObjectUrl(id) {
  const url = objectUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(id);
}

function getObjectUrl(item) {
  const existing = objectUrls.get(item.id);
  if (existing) return existing;
  const url = URL.createObjectURL(item.imageBlob);
  objectUrls.set(item.id, url);
  return url;
}

function normalizeOcrToken(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokenQuality(token) {
  if (token.length !== 4) return -100;
  let score = 0;
  if (/[A-Z]/.test(token)) score += 3;
  if (/\d/.test(token)) score += 8;
  if (/^[A-Z0-9]{4}$/.test(token)) score += 4;
  if (/^(THE|AND|THIS|THAT|WITH|FROM)$/i.test(token)) score -= 20;
  return score;
}

function groupWordsIntoLines(words) {
  const usable = words
    .filter((word) => word?.text && word?.bbox)
    .map((word) => ({
      text: word.text,
      confidence: Number(word.confidence) || 0,
      x0: word.bbox.x0,
      y0: word.bbox.y0,
      x1: word.bbox.x1,
      y1: word.bbox.y1,
      height: Math.max(1, word.bbox.y1 - word.bbox.y0),
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const lines = [];
  for (const word of usable) {
    const centerY = (word.y0 + word.y1) / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const line of lines) {
      const tolerance = Math.max(word.height, line.averageHeight) * 0.65;
      const distance = Math.abs(centerY - line.centerY);
      if (distance <= tolerance && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      lines.push({ words: [word], centerY, averageHeight: word.height });
    } else {
      best.words.push(word);
      best.centerY = best.words.reduce((sum, entry) => sum + (entry.y0 + entry.y1) / 2, 0) / best.words.length;
      best.averageHeight = best.words.reduce((sum, entry) => sum + entry.height, 0) / best.words.length;
    }
  }

  return lines.map((line) => ({ ...line, words: line.words.sort((a, b) => a.x0 - b.x0) }));
}

function extractBestSerial(ocrData, imageWidth, imageHeight) {
  const candidates = [];
  const lines = groupWordsIntoLines(ocrData.words ?? []);

  for (const line of lines) {
    const tokens = line.words.map((word) => ({ ...word, token: normalizeOcrToken(word.text) }));

    for (let start = 0; start <= tokens.length - 4; start += 1) {
      const group = tokens.slice(start, start + 4);
      if (!group.every((entry) => entry.token.length === 4)) continue;

      const value = group.map((entry) => entry.token).join('');
      const digitGroups = group.filter((entry) => /\d/.test(entry.token)).length;
      const totalDigits = (value.match(/\d/g) ?? []).length;
      const averageConfidence = group.reduce((sum, entry) => sum + entry.confidence, 0) / 4;
      const averageHeight = group.reduce((sum, entry) => sum + entry.height, 0) / 4;
      const left = group[0].x0;
      const right = group[3].x1;
      const width = Math.max(1, right - left);
      const centerY = group.reduce((sum, entry) => sum + (entry.y0 + entry.y1) / 2, 0) / 4;
      const gaps = [1, 2, 3].map((index) => Math.max(0, group[index].x0 - group[index - 1].x1));
      const gapAverage = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      const gapVariance = gaps.reduce((sum, gap) => sum + Math.abs(gap - gapAverage), 0) / gaps.length;

      let score = group.reduce((sum, entry) => sum + tokenQuality(entry.token), 0);
      score += averageConfidence * 0.35;
      score += Math.min(35, (averageHeight / imageHeight) * 900);
      score += Math.min(20, (width / imageWidth) * 40);
      score += digitGroups * 12 + totalDigits * 2;
      score -= Math.min(18, (gapVariance / Math.max(1, averageHeight)) * 8);
      if (digitGroups < 2) score -= 55;
      if (totalDigits < 3) score -= 35;
      if (centerY < imageHeight * 0.12 || centerY > imageHeight * 0.78) score -= 8;

      candidates.push({ value, score });
    }
  }

  const rawLines = (ocrData.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const rawLine of rawLines) {
    const spacedTokens = rawLine.split(/\s+/).map(normalizeOcrToken).filter(Boolean);
    for (let start = 0; start <= spacedTokens.length - 4; start += 1) {
      const group = spacedTokens.slice(start, start + 4);
      if (!group.every((token) => token.length === 4)) continue;
      const value = group.join('');
      const digitGroups = group.filter((token) => /\d/.test(token)).length;
      const totalDigits = (value.match(/\d/g) ?? []).length;
      let score = group.reduce((sum, token) => sum + tokenQuality(token), 0) + digitGroups * 8 + totalDigits;
      if (digitGroups < 2) score -= 65;
      if (totalDigits < 3) score -= 40;
      candidates.push({ value, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.value ?? '';
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

function drawScaledImage(image, canvas, maxEdge, enhance = false) {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = Math.min(1, maxEdge / longest);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: enhance });
  if (!ctx) throw new Error('画像処理を開始できませんでした。');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  if (enhance) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 128));
      data[i] = contrasted;
      data[i + 1] = contrasted;
      data[i + 2] = contrasted;
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return canvas;
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.82) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('確認用画像を保存できませんでした。')), type, quality);
  });
}

async function recognizeSerial(image) {
  if (!window.Tesseract) throw new Error('OCR機能を読み込めませんでした。通信状態を確認してください。');
  const canvas = drawScaledImage(image, processingCanvas, MAX_OCR_EDGE, true);
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
      setStatus(labels[message.status] ?? '読み取り中です', percent, true);
    },
  });
  return extractBestSerial(result.data ?? {}, canvas.width, canvas.height);
}

async function makeStoredImage(image) {
  drawScaledImage(image, storageCanvas, MAX_STORED_EDGE, false);
  return canvasToBlob(storageCanvas);
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateHistoryHeader() {
  historyCount.textContent = `${items.length}件`;
  emptyState.hidden = items.length > 0;
  deleteAllButton.hidden = items.length === 0;
}

function renderHistory() {
  historyList.replaceChildren();
  for (const item of items) historyList.append(createHistoryCard(item));
  updateHistoryHeader();
}

function createHistoryCard(item) {
  const card = document.createElement('article');
  card.className = 'panel history-card';
  card.dataset.id = item.id;

  const header = document.createElement('div');
  header.className = 'card-heading';
  const number = document.createElement('span');
  number.className = 'card-number';
  number.textContent = String(items.indexOf(item) + 1);
  const date = document.createElement('time');
  date.dateTime = new Date(item.createdAt).toISOString();
  date.textContent = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.createdAt);
  header.append(number, date);

  const image = document.createElement('img');
  image.className = 'history-image';
  image.src = getObjectUrl(item);
  image.alt = '撮影したシリアルコードの確認用画像';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = '読み取り結果（編集できます）';

  const input = document.createElement('input');
  input.className = 'serial-input';
  input.type = 'text';
  input.inputMode = 'text';
  input.autocapitalize = 'characters';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 19;
  input.value = formatSerial(item.serialCode);
  label.htmlFor = `serial-${item.id}`;
  input.id = label.htmlFor;

  const validation = document.createElement('p');
  validation.className = 'validation-message';

  const buttonGrid = document.createElement('div');
  buttonGrid.className = 'button-grid';
  const copyButton = document.createElement('button');
  copyButton.className = 'secondary-button';
  copyButton.type = 'button';
  copyButton.textContent = 'コピーだけ';
  const copyOpenButton = document.createElement('button');
  copyOpenButton.className = 'primary-button';
  copyOpenButton.type = 'button';
  copyOpenButton.innerHTML = 'コピーして<br>入力ページへGO';
  buttonGrid.append(copyButton, copyOpenButton);

  const deleteButton = document.createElement('button');
  deleteButton.className = 'text-button danger';
  deleteButton.type = 'button';
  deleteButton.textContent = 'この履歴を削除';

  const refreshValidation = () => {
    input.value = formatSerial(input.value);
    const valid = isValidSerial(input.value);
    validation.textContent = valid
      ? '16文字です。写真と見比べて、読み取り結果を確認してください。'
      : `現在 ${compactSerial(input.value).length} 文字です。16文字の英数字にしてください。`;
    validation.classList.toggle('valid', valid);
    copyButton.disabled = !valid;
    copyOpenButton.disabled = !valid;
    return valid;
  };

  const persistCode = async () => {
    item.serialCode = compactSerial(input.value).slice(0, 16);
    item.updatedAt = Date.now();
    await saveItem(item);
  };

  input.addEventListener('input', refreshValidation);
  input.addEventListener('change', () => void persistCode().catch(() => window.alert('編集内容を保存できませんでした。')));
  input.addEventListener('blur', () => {
    refreshValidation();
    void persistCode().catch(() => window.alert('編集内容を保存できませんでした。'));
  });

  const copyCurrent = async () => {
    if (!refreshValidation()) return false;
    await persistCode();
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      if (!document.execCommand('copy')) throw new Error('コピーできませんでした。');
    }
    return true;
  };

  copyButton.addEventListener('click', async () => {
    try {
      if (await copyCurrent()) setStatus('シリアルコードをコピーしました', 100, true);
    } catch {
      window.alert('コピーできませんでした。文字列を長押ししてコピーしてください。');
    }
  });

  copyOpenButton.addEventListener('click', async () => {
    try {
      if (await copyCurrent()) window.location.assign(OFFICIAL_URL);
    } catch {
      window.alert('コピーできませんでした。文字列を長押ししてコピーしてください。');
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (!window.confirm('この履歴を削除しますか？')) return;
    try {
      await deleteItemFromDb(item.id);
      revokeObjectUrl(item.id);
      items = items.filter((entry) => entry.id !== item.id);
      renderHistory();
    } catch {
      window.alert('履歴を削除できませんでした。');
    }
  });

  refreshValidation();
  card.append(header, image, label, input, validation, buttonGrid, deleteButton);
  return card;
}

async function handleImage(file) {
  if (busy || !file) return;
  if (!file.type.startsWith('image/')) {
    window.alert('画像ファイルを選んでください。');
    return;
  }

  busy = true;
  imageInput.disabled = true;
  setStatus('写真を読み込んでいます', 2, true);

  let sourceUrl = null;
  try {
    const loaded = await loadImage(file);
    sourceUrl = loaded.url;
    const [serialCode, imageBlob] = await Promise.all([
      recognizeSerial(loaded.image),
      makeStoredImage(loaded.image),
    ]);

    const now = Date.now();
    const item = {
      id: createId(),
      serialCode: compactSerial(serialCode).slice(0, 16),
      imageBlob,
      createdAt: now,
      updatedAt: now,
    };
    await saveItem(item);
    items.unshift(item);
    renderHistory();
    setStatus(item.serialCode.length === 16 ? '読み取りが終わりました' : '16文字を確定できませんでした。結果を手で修正してください。', 100, true);
    historyList.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : '読み取りに失敗しました。', 0, true);
    window.alert('読み取りに失敗しました。写真を撮り直してください。');
  } finally {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    imageInput.value = '';
    imageInput.disabled = false;
    busy = false;
  }
}

imageInput.addEventListener('change', () => {
  const [file] = imageInput.files ?? [];
  void handleImage(file);
});

deleteAllButton.addEventListener('click', async () => {
  if (!window.confirm('すべての履歴を削除しますか？')) return;
  try {
    await clearDatabase();
    for (const item of items) revokeObjectUrl(item.id);
    items = [];
    renderHistory();
    setStatus('すべての履歴を削除しました', 100, true);
  } catch {
    window.alert('履歴を削除できませんでした。');
  }
});

window.addEventListener('pagehide', () => {
  for (const id of objectUrls.keys()) revokeObjectUrl(id);
});

(async function initialize() {
  try {
    items = (await readAllItems()).sort((a, b) => b.createdAt - a.createdAt);
    renderHistory();
  } catch (error) {
    console.error(error);
    renderHistory();
    window.alert('履歴保存を利用できません。Safariの通常タブで開いてください。');
  }
})();
