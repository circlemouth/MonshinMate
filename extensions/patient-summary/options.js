'use strict';

const API_KEY_HEADER = 'X-MonshinMate-Api-Key';
const DEFAULT_SETTINGS = {
  apiUrl: '',
  apiKey: '',
  nameXPath: '',
  dobXPath: '',
  selectedPreset: 'user1',
  presets: {
    user1: { nameXPath: '', dobXPath: '' },
    user2: { nameXPath: '', dobXPath: '' },
  },
};

const KIRIN_PRESET = {
  nameXPath: '//*[@id="FullName"]',
  dobXPath: '//*[@id="otherDataBox"]/span[2]',
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
const presetSelector = document.getElementById('presetSelector');
const saveButton = document.getElementById('saveButton');
const fetchButton = document.getElementById('fetchButton');

let isWorking = false;
let currentSettings = { ...DEFAULT_SETTINGS };

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
      // Merge defaults for nested objects (presets) if they are partial or missing
      const mergedPresets = { ...DEFAULT_SETTINGS.presets, ...items.presets };
      const settings = { ...items, presets: mergedPresets };
      resolve(settings);
    });
  });

const saveSettings = (settings) =>
  new Promise((resolve, reject) => {
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        currentSettings = settings;
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

const collectCurrentSettings = () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  // Name and DOB are read from inputs.
  // If inputs are disabled (Kirin), they hold Kirin values.
  const nameXPath = nameInput.value.trim();
  const dobXPath = dobInput.value.trim();
  const selectedPreset = presetSelector.value;

  // Create a copy of presets to update
  const newPresets = { ...currentSettings.presets };

  // If a user preset is selected, update it with current values
  if (selectedPreset === 'user1' || selectedPreset === 'user2') {
    newPresets[selectedPreset] = {
      nameXPath,
      dobXPath
    };
  }

  return {
    apiUrl,
    apiKey,
    nameXPath,
    dobXPath,
    selectedPreset,
    presets: newPresets
  };
};

const handleFetch = async () => {
  if (isWorking) return;
  const settings = collectCurrentSettings();

  if (!settings.apiUrl || !settings.apiKey || !settings.nameXPath || !settings.dobXPath) {
    setStatus(ERROR_MESSAGES.incompleteSettings, 'error');
    return;
  }

  // 自動保存
  try {
    await saveSettings(settings);
  } catch (e) {
    console.error('Auto save failed', e);
  }

  isWorking = true;
  fetchButton.disabled = true;
  setStatus('患者情報を取得しています...');
  try {
    const tabId = await getActiveTabId();
    const patientInfo = await resolvePatientInfo(tabId, settings.nameXPath, settings.dobXPath);
    if (!patientInfo?.name || !patientInfo?.dob) {
      throw new Error(ERROR_MESSAGES.missingPatientInfo);
    }
    const normalizedDob = normalizeDob(patientInfo.dob);
    const markdown = await fetchMarkdown(settings.apiUrl, settings.apiKey, patientInfo.name, normalizedDob);
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

const updateInputState = () => {
  const val = presetSelector.value;
  const isKirin = val === 'kirin';
  nameInput.disabled = isKirin;
  dobInput.disabled = isKirin;

  const bg = isKirin ? '#e2e8f0' : '#f9fafb';
  nameInput.style.backgroundColor = bg;
  dobInput.style.backgroundColor = bg;
};

const initialize = async () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  currentSettings = await loadSettings();

  apiUrlInput.value = currentSettings.apiUrl;
  apiKeyInput.value = currentSettings.apiKey;
  nameInput.value = currentSettings.nameXPath;
  dobInput.value = currentSettings.dobXPath;

  let initialPreset = currentSettings.selectedPreset || 'user1';

  // Legacy fallback: if it was 'custom', switch to 'user1' (which will be populated with current values on save)
  if (initialPreset === 'custom') {
    initialPreset = 'user1';
  }

  presetSelector.value = initialPreset;
  updateInputState();
};

document.addEventListener('DOMContentLoaded', () => {
  // Initialize
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

      let foundValue = null;
      let errorMsg = null;

      for (const frameResult of results) {
        const val = frameResult.result;
        if (val && typeof val === 'object' && val.error) {
          errorMsg = val.error;
        } else if (val) {
          foundValue = val;
          break;
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
      preview.textContent = '...'; // Silent fail or clear
    }
  };

  nameInput.addEventListener('blur', () => updatePreview('nameXPath', 'namePreview'));
  dobInput.addEventListener('blur', () => updatePreview('dobXPath', 'dobPreview'));

  presetSelector.addEventListener('change', () => {
    const val = presetSelector.value;
    if (val === 'kirin') {
      nameInput.value = KIRIN_PRESET.nameXPath;
      dobInput.value = KIRIN_PRESET.dobXPath;
    } else if (val === 'user1' && currentSettings.presets.user1) {
      nameInput.value = currentSettings.presets.user1.nameXPath || '';
      dobInput.value = currentSettings.presets.user1.dobXPath || '';
    } else if (val === 'user2' && currentSettings.presets.user2) {
      nameInput.value = currentSettings.presets.user2.nameXPath || '';
      dobInput.value = currentSettings.presets.user2.dobXPath || '';
    } else {
      // If 'custom' is selected (or any other unrecognized value),
      // we don't change the input values, allowing the user to edit them.
      // The values will be saved to the currently selected preset (or 'user1' if 'custom' was selected and then saved).
    }

    updateInputState();

    // Auto preview on switch
    // Note: We don't want to spam warnings if fields are empty, so only if not empty?
    if (nameInput.value) updatePreview('nameXPath', 'namePreview');
    else document.getElementById('namePreview').textContent = '';

    if (dobInput.value) updatePreview('dobXPath', 'dobPreview');
    else document.getElementById('dobPreview').textContent = '';
  });

  const shortcutLink = document.getElementById('shortcutLink');
  if (shortcutLink) {
    shortcutLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  saveButton.addEventListener('click', async () => {
    const settings = collectCurrentSettings();
    try {
      await saveSettings(settings);
      setStatus('設定を保存しました。', 'success');
    } catch (error) {
      console.error(error);
      setStatus(ERROR_MESSAGES.saveFail, 'error');
    }
  });

  fetchButton.addEventListener('click', async () => {
    await handleFetch();
  });

  const showApiKeyCheckbox = document.getElementById('showApiKey');
  if (showApiKeyCheckbox) {
    showApiKeyCheckbox.addEventListener('change', (e) => {
      // typeは常にtext。見た目のマスクはclassで制御する。
      apiKeyInput.classList.toggle('masked', !e.target.checked);
    });
  }
});
