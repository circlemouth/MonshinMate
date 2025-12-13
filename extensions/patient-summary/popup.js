'use strict';

// ===== 定数 =====
const API_KEY_HEADER = 'X-MonshinMate-Api-Key';

const MESSAGES = {
    loading: '問診を取得中...',
    success: '問診結果をコピーしました',
    missingSettings: '設定が未完了です',
    missingPatientInfo: '患者情報が取得できませんでした。カルテ画面で患者を開いてから実行してください。',
    apiError: (status, detail) => {
        if (status === 401) return 'APIキーが無効です。管理画面でキーを確認してください。';
        if (status === 404) return '最新の問診が見つかりませんでした。患者名・生年月日と確定済みかをご確認ください。';
        return detail ? `APIエラー (${status}): ${detail}` : `API通信で${status}エラーが発生しました。`;
    },
    networkError: '接続に失敗しました。APIエンドポイントURLを確認してください。',
    markdownMissing: '問診結果が届きませんでした。',
    genericError: '処理に失敗しました。',
    saved: '設定を保存しました',
};

// ===== プリセット定義 =====
const PRESETS = {
    kirin: {
        nameXPath: '//*[@id="FullName"]',
        dobXPath: '//*[@id="otherDataBox"]/span[2]',
        readonly: true
    },
    user1: { nameXPath: '', dobXPath: '', readonly: false },
    user2: { nameXPath: '', dobXPath: '', readonly: false }
};

// ===== 日付正規化ユーティリティ =====
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
    let cleaned = value
        .replace(/[\s　]+生.*$/g, '')
        .replace(/\(.*?\)/g, '')
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

// ===== DOM要素 =====
const mainContainer = document.getElementById('mainContainer');
const statusView = document.getElementById('statusView');
const settingsView = document.getElementById('settingsView');
const errorBanner = document.getElementById('errorBanner');

const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const showApiKeyCheckbox = document.getElementById('showApiKey');
const presetSelector = document.getElementById('presetSelector');
const nameXPathInput = document.getElementById('nameXPath');
const dobXPathInput = document.getElementById('dobXPath');
const namePreview = document.getElementById('namePreview');
const dobPreview = document.getElementById('dobPreview');
const saveButton = document.getElementById('saveButton');
const saveAndRetryButton = document.getElementById('saveAndRetryButton');
const shortcutLink = document.getElementById('shortcutLink');

// ===== 定数 =====
const TIMEOUT_MS = 5000; // 5秒でタイムアウト

// ===== UI更新関数 =====
const showLoading = () => {
    mainContainer.classList.remove('expanded');
    statusView.className = 'status-view loading';
    statusView.innerHTML = `
        <div class="icon">⏳</div>
        <div class="content">
            <div class="message">取得中...</div>
        </div>
    `;
    statusView.style.display = 'flex';
    settingsView.classList.remove('visible');
};

const showSuccess = () => {
    mainContainer.classList.remove('expanded');
    statusView.className = 'status-view success';
    statusView.innerHTML = `
        <div class="icon">✅</div>
        <div class="content">
            <div class="message">コピーしました！</div>
        </div>
    `;
    statusView.style.display = 'flex';
    settingsView.classList.remove('visible');

    // 1.5秒後にポップアップを閉じる
    setTimeout(() => {
        window.close();
    }, 1500);
};

const showError = (message, showSettings = false) => {
    if (showSettings) {
        // エラーバナー付きで設定画面を表示
        mainContainer.classList.add('expanded');
        statusView.style.display = 'none';
        settingsView.classList.add('visible');
        errorBanner.textContent = message;
        errorBanner.style.display = 'block';
        errorBanner.style.backgroundColor = '#fee2e2';
        errorBanner.style.color = '#991b1b';
    } else {
        // コンパクトなエラー表示
        mainContainer.classList.remove('expanded');
        statusView.className = 'status-view error';
        statusView.innerHTML = `
            <div class="icon">❌</div>
            <div class="content">
                <div class="message">エラー</div>
                <div class="detail">${message}</div>
            </div>
        `;
        statusView.style.display = 'flex';
        settingsView.classList.remove('visible');
    }
};

const showSettingsForm = () => {
    mainContainer.classList.add('expanded');
    statusView.style.display = 'none';
    settingsView.classList.add('visible');
    errorBanner.style.display = 'none';
};

// ===== 設定管理 =====
const loadSettings = async () => {
    const settings = await chrome.storage.sync.get({
        apiUrl: '',
        apiKey: '',
        nameXPath: '',
        dobXPath: '',
        activePreset: 'user1',
        user1NameXPath: '',
        user1DobXPath: '',
        user2NameXPath: '',
        user2DobXPath: ''
    });

    apiUrlInput.value = settings.apiUrl;
    apiKeyInput.value = settings.apiKey;
    presetSelector.value = settings.activePreset;
    nameXPathInput.value = settings.nameXPath;
    dobXPathInput.value = settings.dobXPath;

    updateXPathInputsState();
    return settings;
};

const saveSettings = async () => {
    const settings = {
        apiUrl: apiUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        nameXPath: nameXPathInput.value.trim(),
        dobXPath: dobXPathInput.value.trim(),
        activePreset: presetSelector.value
    };

    // ユーザープリセットの場合はプリセット用の値も保存
    const preset = presetSelector.value;
    if (preset === 'user1') {
        settings.user1NameXPath = settings.nameXPath;
        settings.user1DobXPath = settings.dobXPath;
    } else if (preset === 'user2') {
        settings.user2NameXPath = settings.nameXPath;
        settings.user2DobXPath = settings.dobXPath;
    }

    await chrome.storage.sync.set(settings);
    return settings;
};

const isSettingsComplete = (settings) => {
    return settings.apiUrl && settings.apiKey && settings.nameXPath && settings.dobXPath;
};

const updateXPathInputsState = () => {
    const preset = presetSelector.value;
    const isKirin = preset === 'kirin';

    nameXPathInput.disabled = isKirin;
    dobXPathInput.disabled = isKirin;

    if (isKirin) {
        nameXPathInput.value = PRESETS.kirin.nameXPath;
        dobXPathInput.value = PRESETS.kirin.dobXPath;
    }
};

// ===== API実行 =====
const withTimeout = (promise, ms) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject({ type: 'timeout', message: 'タイムアウトしました。ページを確認してください。' }), ms)
        )
    ]);
};

const executeApiCall = async (settings) => {
    // アクティブなタブを取得
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
        throw { type: 'other', message: 'アクティブなタブが見つかりません。' };
    }

    // ページから患者情報を取得（タイムアウト付き）
    const results = await withTimeout(
        chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: (nameXPath, dobXPath) => {
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
                    name: evalXPath(nameXPath),
                    dob: evalXPath(dobXPath),
                };
            },
            args: [settings.nameXPath, settings.dobXPath]
        }),
        TIMEOUT_MS
    );

    // 結果を探す
    let name = null;
    let dob = null;
    for (const frameResult of results) {
        const info = frameResult.result;
        if (info && info.name) name = info.name;
        if (info && info.dob) dob = info.dob;
        if (name && dob) break;
    }

    if (!name || !dob) {
        throw { type: 'patient_info', message: MESSAGES.missingPatientInfo };
    }

    const normalizedDob = normalizeDob(dob);

    // APIリクエスト
    let response;
    try {
        response = await fetch(settings.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [API_KEY_HEADER]: settings.apiKey,
            },
            body: JSON.stringify({ patient_name: name, dob: normalizedDob }),
        });
    } catch (networkError) {
        throw { type: 'network', message: MESSAGES.networkError };
    }

    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const detailText = detail?.detail || '';

        if (response.status === 401) {
            throw { type: 'auth', message: MESSAGES.apiError(401, detailText) };
        } else if (response.status === 404) {
            throw { type: 'not_found', message: MESSAGES.apiError(404, detailText) };
        } else if (response.status >= 500) {
            throw { type: 'server', message: MESSAGES.apiError(response.status, detailText) };
        } else {
            throw { type: 'other', message: MESSAGES.apiError(response.status, detailText) };
        }
    }

    const payload = await response.json();
    if (!payload?.markdown) {
        throw { type: 'data', message: MESSAGES.markdownMissing };
    }

    // クリップボードにコピー
    await navigator.clipboard.writeText(payload.markdown);

    return payload.markdown;
};

// ===== イベントハンドラ =====
showApiKeyCheckbox.addEventListener('change', () => {
    apiKeyInput.type = showApiKeyCheckbox.checked ? 'text' : 'password';
});

presetSelector.addEventListener('change', async () => {
    const preset = presetSelector.value;
    updateXPathInputsState();

    if (preset !== 'kirin') {
        // ユーザープリセットの保存済み値を読み込む
        const settings = await chrome.storage.sync.get({
            user1NameXPath: '',
            user1DobXPath: '',
            user2NameXPath: '',
            user2DobXPath: ''
        });

        if (preset === 'user1') {
            nameXPathInput.value = settings.user1NameXPath;
            dobXPathInput.value = settings.user1DobXPath;
        } else if (preset === 'user2') {
            nameXPathInput.value = settings.user2NameXPath;
            dobXPathInput.value = settings.user2DobXPath;
        }
    }
});

saveButton.addEventListener('click', async () => {
    await saveSettings();
    errorBanner.textContent = MESSAGES.saved;
    errorBanner.style.display = 'block';
    errorBanner.style.backgroundColor = '#ecfdf5';
    errorBanner.style.color = '#059669';
    setTimeout(() => {
        window.close();
    }, 1000);
});

saveAndRetryButton.addEventListener('click', async () => {
    await saveSettings();
    init(); // 再実行
});

shortcutLink.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ===== 初期化 =====
const init = async () => {
    showLoading();

    const settings = await loadSettings();

    // 設定が未完了の場合は設定フォームを表示
    if (!isSettingsComplete(settings)) {
        showSettingsForm();
        return;
    }

    // 設定完了の場合はAPI実行
    try {
        await executeApiCall(settings);
        showSuccess();
    } catch (error) {
        console.error(error);

        const message = error?.message || MESSAGES.genericError;
        const shouldShowSettings = error?.type === 'auth' || error?.type === 'network' || error?.type === 'patient_info' || error?.type === 'timeout';

        showError(message, shouldShowSettings);
    }
};

// 起動時に初期化
init();
