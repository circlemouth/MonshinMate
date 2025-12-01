'use strict';

const API_KEY_HEADER = 'X-MonshinMate-Api-Key';
const DEFAULT_SETTINGS = {
  apiUrl: '',
  apiKey: '',
  nameXPath: '',
  dobXPath: '',
};

const ERROR_MESSAGES = {
  incompleteSettings: '設定をすべて入力してください。',
  noActiveTab: 'アクティブタブがありません。',
  invalidXPath: 'XPathの形式が正しくありません。',
  missingPatientInfo: '患者情報が取得できませんでした。',
  missingElement: '要素が見つかりません。',
  apiError: (status) => `API通信で${status}エラーが発生しました。`,
  markdownMissing: '問診結果が届きませんでした。',
  fetchFail: '取得に失敗しました。',
  previewFail: '要素の確認に失敗しました。',
  loadFail: '設定の読み込みに失敗しました。',
  saveFail: '設定の保存に失敗しました。',
};

const friendlyErrorMessages = new Set(
  Object.values(ERROR_MESSAGES).filter((value) => typeof value === 'string')
);

const isFriendlyStatus = (text) =>
  Boolean(text && (friendlyErrorMessages.has(text) || text.startsWith('API通信で')));

const statusEl = document.getElementById('statusText');
const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const nameInput = document.getElementById('nameXPath');
const dobInput = document.getElementById('dobXPath');
const saveButton = document.getElementById('saveButton');
const fetchButton = document.getElementById('fetchButton');
if (fetchButton) {
  fetchButton.textContent = '設定を保存してテスト実行';
}
let isWorking = false;

const setStatus = (text, type = 'info') => {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle('success', type === 'success');
  statusEl.classList.toggle('error', type === 'error');
};

const formatIso = (year, month, day) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
};

const isValidDate = (year, month, day) => {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const candidate = new Date(year, month - 1, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day;
};

const normalizeStandardDate = (value) => {
  // まず末尾の「生」などを除去し、括弧内の和暦を除去
  let cleaned = value
    .replace(/[\s　]+生.*$/g, '') // 「生」以降を除去
    .replace(/\(.*?\)/g, '') // 括弧内（和暦）を除去
    .replace(/年|月/g, '-')
    .replace(/日/g, '')
    .replace(/[./\\]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  const standardMatch = cleaned.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (standardMatch) {
    const [, year, month, day] = standardMatch;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (isValidDate(y, m, d)) {
      return formatIso(y, m, d);
    }
  }
  const altMatch = cleaned.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (altMatch) {
    const [, month, day, year] = altMatch;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (isValidDate(y, m, d)) {
      return formatIso(y, m, d);
    }
  }
  const digitsOnly = value.replace(/\D/g, '');
  if (digitsOnly.length === 8) {
    const year = Number(digitsOnly.slice(0, 4));
    const month = Number(digitsOnly.slice(4, 6));
    const day = Number(digitsOnly.slice(6, 8));
    if (isValidDate(year, month, day)) {
      return formatIso(year, month, day);
    }
  }
  return null;
};

const eraDefinitions = [
  { names: ['令和', 'reiwa', 'Reiwa', 'R'], base: 2018 },
  { names: ['平成', 'heisei', 'Heisei', 'H'], base: 1988 },
  { names: ['昭和', 'showa', 'Showa', 'S'], base: 1925 },
  { names: ['大正', 'taisho', 'Taisho', 'T'], base: 1911 },
  { names: ['明治', 'meiji', 'Meiji', 'M'], base: 1867 },
];

const extractMonthDay = (text) => {
  if (!text) return null;
  const monthMatch = text.match(/(\d{1,2})月/);
  const dayMatch = text.match(/(\d{1,2})日/);
  if (monthMatch && dayMatch) {
    const month = Number(monthMatch[1]);
    const day = Number(dayMatch[1]);
    if (isValidDate(2000, month, day)) {
      return { month, day };
    }
  }
  const pairMatch = text.match(/(\d{1,2})\D+(\d{1,2})/);
  if (pairMatch) {
    const month = Number(pairMatch[1]);
    const day = Number(pairMatch[2]);
    if (isValidDate(2000, month, day)) {
      return { month, day };
    }
  }
  const digits = text.match(/(\d{1,2})/g);
  if (digits && digits.length >= 2) {
    const month = Number(digits[0]);
    const day = Number(digits[1]);
    if (isValidDate(2000, month, day)) {
      return { month, day };
    }
  }
  return null;
};

const normalizeEraDate = (value) => {
  const trimmed = value.trim();
  for (const definition of eraDefinitions) {
    const regex = new RegExp(`(${definition.names.join('|')})\\s*(元|\\d{1,2})`, 'i');
    const match = trimmed.match(regex);
    if (!match) continue;
    const [, eraRaw, yearToken] = match;
    const base = definition.base;
    const yearNumber = yearToken === '元' ? 1 : Number(yearToken);
    if (!Number.isFinite(yearNumber)) {
      continue;
    }
    const year = base + yearNumber;
    const remainder = trimmed.slice(match.index + match[0].length);
    const monthDay = extractMonthDay(remainder);
    if (!monthDay) continue;
    if (isValidDate(year, monthDay.month, monthDay.day)) {
      return formatIso(year, monthDay.month, monthDay.day);
    }
  }
  return null;
};

const normalizeDob = (value) => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return normalizeStandardDate(trimmed) || normalizeEraDate(trimmed) || trimmed;
};

const showDesktopNotification = (message) => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification('問診結果取得', { body: message });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        new Notification('問診結果取得', { body: message });
      }
    });
  }
};

const loadSettings = () =>
  new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      resolve({
        apiUrl: items.apiUrl || '',
        apiKey: items.apiKey || '',
        nameXPath: items.nameXPath || '',
        dobXPath: items.dobXPath || '',
      });
    });
  });

const saveSettings = (settings) =>
  new Promise((resolve, reject) => {
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(settings);
      }
    });
  });

const getActiveTabId = () =>
  new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      const tab = tabs[0];
    if (!tab || typeof tab.id !== 'number') {
      reject(new Error(ERROR_MESSAGES.noActiveTab));
        return;
      }
      resolve(tab.id);
    });
  });

const resolvePatientInfo = async (tabId, nameXPath, dobXPath) => {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (nameExpr, dobExpr) => {
      const evalXPath = (xpath) => {
        if (!xpath) return null;
        try {
          const evaluator = document.evaluate(xpath, document, null, XPathResult.STRING_TYPE, null);
          const value = evaluator ? evaluator.stringValue : '';
          return typeof value === 'string' ? value.trim() : null;
        } catch (error) {
          return null;
        }
      };
      return {
        name: evalXPath(nameExpr),
        dob: evalXPath(dobExpr),
      };
    },
    args: [nameXPath, dobXPath],
  });

  // 全フレームから有効な結果を探す
  let name = null;
  let dob = null;

  for (const frameResult of results) {
    const info = frameResult.result;
    if (info && info.name) name = info.name;
    if (info && info.dob) dob = info.dob;
    if (name && dob) break; // 両方見つかったら終了
  }

  if (!name || !dob) {
    throw new Error(ERROR_MESSAGES.missingPatientInfo);
  }

  return { name, dob };
};

const fetchMarkdown = async (endpoint, key, name, dob) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      [API_KEY_HEADER]: key,
    },
    body: JSON.stringify({ patient_name: name, dob }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    if (detail?.detail) {
      console.error('API error detail:', detail.detail);
    }
    throw new Error(ERROR_MESSAGES.apiError(response.status));
  }
  const payload = await response.json();
  if (!payload?.markdown) {
    throw new Error(ERROR_MESSAGES.markdownMissing);
  }
  return payload.markdown;
};

const copyToClipboard = async (text) => {
  await navigator.clipboard.writeText(text);
};

const handleFetch = async () => {
  if (isWorking) return;
  const endpoint = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const nameXPath = nameInput.value.trim();
  const dobXPath = dobInput.value.trim();
  if (!endpoint || !apiKey || !nameXPath || !dobXPath) {
    setStatus(ERROR_MESSAGES.incompleteSettings, 'error');
    return;
  }
  isWorking = true;
  fetchButton.disabled = true;
  setStatus('患者情報を取得しています...');
  try {
    const tabId = await getActiveTabId();
    const patientInfo = await resolvePatientInfo(tabId, nameXPath, dobXPath);
    if (!patientInfo?.name || !patientInfo?.dob) {
      throw new Error(ERROR_MESSAGES.missingPatientInfo);
    }
    const normalizedDob = normalizeDob(patientInfo.dob);
    const markdown = await fetchMarkdown(endpoint, apiKey, patientInfo.name, normalizedDob);
    await copyToClipboard(markdown);
    setStatus('Markdownをクリップボードにコピーしました。', 'success');
    showDesktopNotification('問診結果をコピーしました。');
  } catch (error) {
    console.error(error);
    const friendlyMessage = isFriendlyStatus(error?.message)
      ? error.message
      : ERROR_MESSAGES.fetchFail;
    setStatus(friendlyMessage, 'error');
  } finally {
    isWorking = false;
    fetchButton.disabled = false;
  }
};

const initialize = async () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  const settings = await loadSettings();
  apiUrlInput.value = settings.apiUrl;
  apiKeyInput.value = settings.apiKey;
  nameInput.value = settings.nameXPath;
  dobInput.value = settings.dobXPath;
};

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => {
    console.error(error);
    setStatus(ERROR_MESSAGES.loadFail, 'error');
  });
  const updatePreview = async (inputId, previewId) => {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    const xpath = input.value.trim();

    if (!xpath) {
      preview.textContent = '';
      return;
    }

    preview.textContent = '確認中...';
    preview.style.color = '#64748b';

    try {
      const tabId = await getActiveTabId();
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (xpathExpr) => {
          try {
            const result = document.evaluate(xpathExpr, document, null, XPathResult.STRING_TYPE, null);
            return result.stringValue ? result.stringValue.trim() : null;
          } catch (e) {
            return { error: ERROR_MESSAGES.invalidXPath };
          }
        },
        args: [xpath],
      });

      // 全フレームの結果から有効な値を探す
      let foundValue = null;
      let errorMsg = null;

      for (const frameResult of results) {
        const val = frameResult.result;
        if (val && typeof val === 'object' && val.error) {
          errorMsg = val.error;
        } else if (val) {
          foundValue = val;
          break; // 見つかったら終了
        }
      }

      if (foundValue) {
        preview.textContent = `取得結果: ${foundValue}`;
        preview.style.color = '#059669';
      } else if (errorMsg) {
        preview.textContent = errorMsg;
        preview.style.color = '#ef4444';
      } else {
        preview.textContent = ERROR_MESSAGES.missingElement;
        preview.style.color = '#f59e0b';
      }
    } catch (err) {
      console.error(err);
      preview.textContent = ERROR_MESSAGES.previewFail;
      preview.style.color = '#ef4444';
    }
  };

  nameInput.addEventListener('blur', () => updatePreview('nameXPath', 'namePreview'));
  dobInput.addEventListener('blur', () => updatePreview('dobXPath', 'dobPreview'));

  // 設定読み込み
  initialize().catch((error) => {
    console.error(error);
    setStatus(ERROR_MESSAGES.loadFail, 'error');
  });

  const shortcutLink = document.getElementById('shortcutLink');
  if (shortcutLink) {
    shortcutLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  saveButton.addEventListener('click', async () => {
    const payload = {
      apiUrl: apiUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      nameXPath: nameInput.value.trim(),
      dobXPath: dobInput.value.trim(),
    };
    try {
      await saveSettings(payload);
      setStatus('設定を保存しました。', 'success');
    } catch (error) {
      console.error(error);
      setStatus(ERROR_MESSAGES.saveFail, 'error');
    }
  });
  fetchButton.addEventListener('click', async () => {
    await saveSettings({
      apiUrl: apiUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      nameXPath: nameInput.value.trim(),
      dobXPath: dobInput.value.trim(),
    });
    await handleFetch();
  });
});
