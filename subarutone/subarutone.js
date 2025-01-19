// オーディオプロセッサ
const audioEngine = "AudioEngine.wasm";
const heapAudioProcessor = "heap_audio_processor.js";

// 操作モード
const Mode = {
    SLIDER: 'slider',
    OTAMATONE: 'otamatone'
};

// 音声処理エンジンの管理クラス
class Duck {
    isEngineReady = false;
    isUserTouched = false;
    isEasyMode = false;
    workletNode = null;
    gainNode = null;
    audioContext = null;
    dummyAudioSource = null;
    micSource = null;
    micStream = null;

    isModeSet() {
        return this.mode != null;
    }
    getMode() {
        return this.mode;
    }

    // オタマトーンの接続
    async connectOtamatone() {
        try {
            // まずは権限を得るために、デフォルトで選ばれるマイクに接続する（iOS以外ではこれで十分である場合が多い）
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }, video: false });

            // マイクの一覧を取得し、その中からオタマトーンである可能性が高いマイクを選ぶ（iOSではヘッドセットマイクが第一選択にならないため）
            const micCandidateLabels = ["外部マイク", "ヘッドセットマイク", "Microphone Input", "Headset Microphone"];
            let micFound = null;
            let micDevices = [];
            const devices = await navigator.mediaDevices.enumerateDevices();
            for (const device of devices) {
                if (device.kind == "audioinput") {
                    micDevices.push(device.label);
                    if (!micFound && micCandidateLabels.includes(device.label)) {
                        // 既存のマイクをいちど切断 (これをしないとオタマトーンモードを切ってもブラウザにマイクマークが残る)
                        this.micStream.getTracks().forEach(track => track.stop());
                        // 新しいマイクを接続
                        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: device.deviceId, autoGainControl: false, echoCancellation: false, noiseSuppression: false }, video: false });
                        micFound = device.label;
                    }
                }
            }
            if (micDevices.length == 0) {
                throw new Error("オタマトーンの検出に失敗しました。");
            }
            View.log("検知できた音声入力デバイス[" + micDevices.join(", ") + "]から\"" + (micFound ? micFound : micDevices[0]) + "\"を採用。オタマトーンを接続しているのに使用できない場合、このログを作者に教えてください。", true);

            // 音声合成エンジンに接続
            this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
            this.micSource.connect(this.workletNode);
            return true;
        } catch (e) {
            View.log("オタマトーンの接続に失敗しました。", true);
            return false;
        }
    }
    // オタマトーンの切り離し (これをしないとオタマトーンモードを切ってもブラウザにマイクマークが残る)
    disconnectOtamatone() {
        if (this.micSource) {
            this.micSource.disconnect(this.workletNode);
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
            this.micSource = null;
        }
    }
    // ダミー音源の接続
    connectDummySource() {
        this.dummyAudioSource = this.audioContext.createConstantSource();
        this.dummyAudioSource.connect(this.workletNode);
        this.dummyAudioSource.start();
    }
    // ダミー音源の切り離し
    disconnectDummySource() {
        if (this.dummyAudioSource) {
            this.dummyAudioSource.stop();
            this.dummyAudioSource.disconnect(this.workletNode);
            this.dummyAudioSource = null;
        }
    }

    // コンストラクタ
    constructor(voiceId) {
        this.isEngineReady = false;
        this.isUserTouched = false;
        this.isEasyMode = false;
        this.engineReadyEvent = new Event("EngineReady");
        this.initAudioWorklet(audioEngine, voiceId);
    }

    // 音声処理エンジンの初期化
    async initAudioWorklet(engine, voiceId) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // 音声処理を行うworkletNodeをロード
        await this.audioContext.audioWorklet.addModule(heapAudioProcessor);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'duck');
        // 音量調節 (小さいので15倍にゲイン)
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.setValueAtTime(15.0, this.audioContext.currentTime);
        // 出力先に接続
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);

        // イベントリスナーをセット
        this.setEventListeners();

        // 音声処理エンジン(WebAssembly)をfetchして、workletNodeに渡す
        const wasmArrayBuffer = await fetch(engine).then(response => response.arrayBuffer());
        this.workletNode.port.postMessage({
            type: 'initialize',
            sampleRate: this.audioContext.sampleRate,
            engine: wasmArrayBuffer,
            voiceId: voiceId,
        });
    }

    // 再生を再開する (主にユーザ操作を起点としてAudioContextを開始させるために使う)
    resume() {
        if (this.audioContext && this.audioContext.state == 'suspended' || this.audioContext.state == 'interrupted') {
            this.audioContext.resume();
        }
    }

    // イベントリスナーをセット
    setEventListeners() {
        // workletNodeからのメッセージの受信イベントをセット
        this.workletNode.port.onmessage = (event) => {
            // 起動完了
            if (event.data.type === 'ready') {
                this.isEngineReady = true;
                document.dispatchEvent(this.engineReadyEvent);
            }
            // 入力された周波数を表示する
            if (event.data.type === 'frequency') {
                View.updateFrequency(event.data.frequency);
            }
            // デバッグ用： ログを表示する
            if (event.data.type === 'log') {
                View.log(event.data.data);
            }
            // エラーを表示する
            if (event.data.type === 'error') {
                View.log(event.data.data, true);
            }
        };
    }

    // かんたんモードと通常モードを切り替える
    toggleEasyMode(isEasyMode) {
        this.isEasyMode = isEasyMode;
        this.workletNode.port.postMessage({ type: 'easy-mode', isEasyMode: isEasyMode });
    }

    // オタマトーンモードに切り替える
    async switchToOtamatoneMode() {
        if (!this.isEngineReady || this.mode == Mode.OTAMATONE) {
            return false;
        }
        
        // ダミー音源の切り離し
        this.disconnectDummySource();
        // マイク(オタマトーン)の接続。初回の場合はユーザの接続許可が必要。
        if (!this.connectOtamatone()) {
            return false;
        }

        // モードの切り替え
        this.mode = Mode.OTAMATONE;
        this.workletNode.port.postMessage({ type: 'mode', mode: Mode.OTAMATONE });

        return true;
    }

    // スライダーモードに切り替える
    switchToSliderMode() {
        if (!this.isEngineReady || this.mode == Mode.SLIDER) {
            return false;
        }

        // マイク(オタマトーン)の切り離し
        this.disconnectOtamatone();

        // ダミー音源の接続
        this.connectDummySource();

        // モードの切り替え
        this.mode = Mode.SLIDER;
        this.workletNode.port.postMessage({ type: 'mode', mode: Mode.SLIDER });

        return true;
    }

    // スライダーモードのとき、周波数を設定する
    setFrequency(frequency) {
        if (!this.isEngineReady || this.mode != Mode.SLIDER) {
            return false;
        }
        // 音声合成エンジンのパラメータに即時の周波数変更をセット
        const frequencyParam = this.workletNode.parameters.get("frequency");
        frequencyParam.setValueAtTime(frequency, this.audioContext.currentTime);
        return true;
    }

    // 終了時にメモリを解放する
    destruct() {
        this.disconnectDummySource();
        this.disconnectOtamatone();
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'destruct' });
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

// 大空スバル
class Subaru extends Duck {
    // スバルの皮をかぶったアヒルを生成
    constructor() {
        const voiceId = 0;
        super(voiceId);
    }

    // あじめる（コンストラクタを直接使ってはいけない理由は特になく、単にSubaru.wakeUp()と書きたかっただけ）
    static wakeUp() {
        return new Subaru();
    }
}


// Viewの管理クラス
class View {
    static duck = null;
    static currentFrequency = 0;
    static frequencyElement = null;
    static sliderElement = null;
    static sliderBarElement = null;
    static overlayElement = null;
    static logElement = null;

    static init(duck) {
        View.duck = duck;
        View.currentFrequency = 0;
        View.frequencyElement = document.getElementById('frequency');
        View.sliderElement = document.getElementById('slider');
        View.sliderBarElement = document.getElementById('slider-bar');
        View.overlayElement = document.getElementById('overlay');
        View.logElement = document.getElementById('log');
        View.setEventListeners();
        View.getReadyOverlay();
    }

    // デバッグ用： ログをJavaScriptのコンソールに表示する。showToUserがtrueの場合、ユーザにも表示する。
    static log(message, showToUser = false) {
        console.log(message);
        if (showToUser) {
            View.logElement.textContent = message;
        }
    }

    // 以下の関数はいずれも、スライダーの周波数範囲が156Hzから1391Hzであることを前提としている。
    // スライダーのマウス位置から周波数を計算する
    static posToFrequency(pos) {
        return 156 * Math.pow(8.9166666667, pos);
    }

    // 周波数からスライダーのマウス位置を計算する
    static frequencyToPos(frequency) {
        if (frequency < 156) {
            return 0;
        }
        return (Math.log2(frequency) - 7.2854022189) * 31.68061394;
    }

    // 周波数から音階を算出する
    static frequencyToScale(frequency) {
        const scale = { 156: "レ#/D#3", 165: "ミ/E3", 175: "ファ/F3", 185: "ファ#/F#3", 196: "ソ/G3", 208: "ソ#/G#3", 220: "ラ/A3", 233: "ラ#/A#3", 247: "シ/B3", 262: "ド/C4", 277: "ド#/C#4", 294: "レ/D4", 311: "レ#/D#4", 330: "ミ/E4", 349: "ファ/F4", 370: "ファ#/F#4", 392: "ソ/G4", 415: "ソ#/G#4", 440: "ラ/A4", 466: "ラ#/A#4", 494: "シ/B4", 523: "ド/C5", 554: "ド#/C#5", 587: "レ/D5", 622: "レ#/D#5", 659: "ミ/E5", 698: "ファ/F5", 740: "ファ#/F#5", 784: "ソ/G5", 831: "ソ#/G#5", 880: "ラ/A5", 932: "ラ#/A#5", 988: "シ/B5", 1047: "ド/C6", 1109: "ド#/C#6", 1175: "レ/D6", 1245: "レ#/D#6", 1319: "ミ/E6", 1397: "ファ/F6" }
        const frequency_ = Math.round(frequency);
        if (frequency_ in scale) {
            return " (" + scale[frequency_] + ")";
        }
        return "";
    }

    // 周波数を表示する
    static updateFrequency(frequency) {
        // 周波数が変わっていない場合は何もしない
        if (View.currentFrequency == frequency) {
            return;
        }
        View.currentFrequency = frequency;
        View.frequencyElement.textContent = Math.round(frequency) + " Hz" + View.frequencyToScale(frequency);
        if (frequency > 0) {
            View.sliderBarElement.style.display = 'block';
            View.sliderBarElement.style.top = "calc(" + View.frequencyToPos(frequency) + '% - 1.5px)';
        } else {
            View.sliderBarElement.style.display = 'none';
        }
    }

    // 周波数をリセットする
    static resetFrequency() {
        View.duck.setFrequency(0);
    }

    // ユーザ操作があったら、必要に応じてduckをSLIDERモードで初期化し、オーバーレイを非表示にし、duckを再生状態にする
    static onUserTouch(initialize = true) {
        if (initialize && !View.duck.isModeSet() && View.duck.isEngineReady) {
            View.duck.switchToSliderMode();
            View.hideOverlay();
        }
        // ユーザ操作を起点として再生を再開する
        View.duck.resume();
    }

    // スライダー上のマウス・タッチ位置で周波数を設定する
    static onSliderMove(pointedY) {
        if (View.duck.getMode() == Mode.SLIDER) {
            const frequencyBar = document.getElementById('slider');
            const rect = frequencyBar.getBoundingClientRect();
            const mouseY = pointedY - rect.top;
            const relativePosition = mouseY / frequencyBar.clientHeight;
            const frequency = View.posToFrequency(relativePosition);
            View.duck.setFrequency(frequency);
        }
    }

    // イベントリスナーをセット
    static setEventListeners() {
        // かんたんモードと通常モードを切り替える
        document.getElementById('easy-mode').addEventListener('click', async () => {
            View.onUserTouch();
            const container = document.getElementById('easy-mode-container');
            const sw = document.getElementById('easy-mode');
            if (sw.classList.contains('checked')) {
                View.duck.toggleEasyMode(false);
                sw.classList.remove('checked');
                container.classList.remove('checked');
            } else {
                View.duck.toggleEasyMode(true);
                sw.classList.add('checked');
                container.classList.add('checked');
            }
            View.hideOverlay();
        });
        // スライダーモードとオタマトーンモードを切り替える
        document.getElementById('otamatone-mode').addEventListener('click', async () => {
            const container = document.getElementById('otamatone-mode-container');
            const sw = document.getElementById('otamatone-mode');
            View.onUserTouch();
            if (sw.classList.contains('checked')) {
                View.duck.switchToSliderMode();
                sw.classList.remove('checked');
                container.classList.remove('checked');
            } else {
                const result = await View.duck.switchToOtamatoneMode();
                console.log(result);
                if (result) {
                    sw.classList.add('checked');
                    container.classList.add('checked');
                }
            }
            // オーバーレイを非表示にする
            View.hideOverlay();
        });

        // オーバーレイをタッチしたら、そのユーザ操作を起点としてduckを再生状態にする
        View.overlayElement.addEventListener('touchstart', (event) => {
            View.onUserTouch();
            event.preventDefault();
        }, { passive: false });
        // 指を当てたとき、話したとき、クリックしたとき、クリックを離したときなど、ユーザ操作があったら直ちにスライダーモードを起動する
        ['click', 'dblclick', 'mouseup', 'mousedown'].forEach(eventType => {
            View.sliderElement.addEventListener(eventType, (event) => {
                View.onUserTouch();
                event.preventDefault();
            }, { passive: false });
            View.overlayElement.addEventListener(eventType, (event) => {
                View.onUserTouch();
                event.preventDefault();
            }, { once: true, passive: false });
        });
        // スライダー上のマウス・タッチ位置で周波数を設定する
        ['mouseover', 'mousemove'].forEach(eventType => {
            View.sliderElement.addEventListener(eventType, (event) => {
                View.onSliderMove(event.clientY);
            });
        });
        // スライダー上のタッチ位置で周波数を設定する
        View.sliderElement.addEventListener('touchstart', (event) => {
            View.onUserTouch();
            event.preventDefault();
            if (event.changedTouches.length > 0) {
                View.onSliderMove(event.changedTouches[0].clientY);
            }
        }, { passive: false });
        View.sliderElement.addEventListener('touchmove', (event) => {
            event.preventDefault();
            if (event.changedTouches.length > 0) {
                View.onSliderMove(event.changedTouches[0].clientY);
            }
        }, { passive: false });
        // 指を離したときに周波数を0にする
        ['touchend', 'touchcancel'].forEach(eventType => {
            View.sliderElement.addEventListener(eventType, (event) => {
                View.onUserTouch();
                event.preventDefault();
                View.resetFrequency();
            });
        });
        // スライダーのマウスが外れたときに周波数を0にする。ただし子要素への移動は無視する (無視しないとWindows環境では再生が安定しない)。
        View.sliderElement.addEventListener('mouseout', (event) => {
            const related = event.relatedTarget;
            if (related && View.sliderElement.contains(related)) {
                return;
            }
            View.resetFrequency();
        });
        // ブラウザが非表示になって、再表示されたときに再生を再開する
        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "hidden") {
                return;
            }
            View.onUserTouch(false);
        });
        // ブラウザが閉じられたときにメモリを解放
        window.addEventListener('beforeunload', () => {
            View.duck.destruct();
        });
    }

    // オーバーレイを準備完了状態にする
    static getReadyOverlay() {
        View.overlayElement.textContent = 'あじめる';
        document.getElementById('easy-mode-container').classList.remove('isnotready');
        document.getElementById('easy-mode').classList.remove('isnotready');
        document.getElementById('otamatone-mode-container').classList.remove('isnotready');
        document.getElementById('otamatone-mode').classList.remove('isnotready');
    }

    // オーバーレイを非表示にする
    static hideOverlay() {
        View.overlayElement.style.display = 'none';
    }
}
