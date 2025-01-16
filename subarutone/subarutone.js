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
        // 出力先に接続
        this.workletNode.connect(this.audioContext.destination);

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

    resume() {
        this.audioContext.resume().then(() => play());
    }
    // ユーザが操作したときに、AudioContextを再開する
    userTouch() {
        if (!this.isUserTouched && this.audioContext) {
            this.resume();
            this.isUserTouched = true;
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
        if (!this.isEngineReady) {
            return false;
        }
        // 設定済みの場合は何もしない
        if (this.mode == Mode.OTAMATONE) {
            return false;
        }
        
        // マイク(オタマトーン)の接続。初回の場合はユーザの接続許可が必要。
        try {
            // まず、任意のマイクを接続し、ユーザからの包括的なマイク使用許可を取得する (使用許可がないとiOSではenumerateDevices()がまともな答えを返さない)
            this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }, video: false });

            // マイクの一覧を取得し、その中からオタマトーンである可能性が高いマイクを選ぶ
            const micCandidateLabels = ["外部マイク", "ヘッドセットマイク", "Microphone Input", "Headset Microphone"];
            let micFound = null;
            let micDevices = [];
            const devices = await navigator.mediaDevices.enumerateDevices();
            for (const device of devices) {
                if (device.kind == "audioinput") {
                    micDevices.push(device.label);
                    if (!micFound && micCandidateLabels.includes(device.label)) {
                        // オタマトーンの可能性が高いマイクを接続する
                        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: device.deviceId, autoGainControl: false, echoCancellation: false, noiseSuppression: false }, video: false });
                        micFound = device.label;
                    }
                }
            }
            if (micDevices.length == 0) {
                View.log("音声入力デバイスが見つかりません。", true);
                return false;
            }
            // ログ出力
            View.log("検知できた音声入力デバイス[" + micDevices.join(", ") + "]から\"" + (micFound ? micFound : micDevices[0]) + "\"を採用。オタマトーンを接続しているのに使用できない場合、このログを作者に教えてください。", true);
            this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
        } catch (e) {
            this.mode = Mode.SLIDER;
            return false;
        }

        // モードの切り替え
        this.mode = Mode.OTAMATONE;
        // ダミー音源の切り離し
        if (this.dummyAudioSource) {
            this.dummyAudioSource.stop();
            this.dummyAudioSource.disconnect(this.workletNode);
            this.dummyAudioSource = null;
        }
        this.micSource.connect(this.workletNode);
        this.workletNode.port.postMessage({ type: 'mode', mode: Mode.OTAMATONE });

        return true;
    }

    // スライダーモードに切り替える
    switchToSliderMode() {
        if (!this.isEngineReady) {
            return;
        }
        // 設定済みの場合は何もしない
        if (this.mode == Mode.SLIDER) {
            return;
        }

        this.mode = Mode.SLIDER;
        // マイク(オタマトーン)の切り離し
        if (this.micSource) {
            this.micSource.disconnect(this.workletNode);
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
            this.micSource = null;
        }
        // ダミー音源は毎回つくる
        this.dummyAudioSource = this.audioContext.createBufferSource();
        this.dummyAudioSource.buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * 1, this.audioContext.sampleRate);
        this.dummyAudioSource.loop = true;
        this.dummyAudioSource.connect(this.workletNode);
        this.dummyAudioSource.start();
        this.resume();
        this.workletNode.port.postMessage({ type: 'mode', mode: Mode.SLIDER });
    }

    // スライダーモードのとき、周波数を設定する
    setFrequency(frequency) {
        if (!this.isEngineReady || this.mode != Mode.SLIDER) {
            return;
        }
        this.userTouch();
        const frequencyParam = this.workletNode.parameters.get("frequency");
        frequencyParam.setValueAtTime(frequency, this.audioContext.currentTime);
    }

    // 終了時にメモリを解放する
    destruct() {
        if (this.dummyAudioSource) {
            this.dummyAudioSource.stop();
            this.dummyAudioSource.disconnect(this.workletNode);
        }
        if (this.micSource) {
            this.micSource.disconnect(this.workletNode);
        }
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
    // スバルのパラメータを入れたアヒルを生成
    constructor() {
        const voiceId = 0;
        super(voiceId);
    }

    // 起こす（コンストラクタを直接使ってはいけない理由は特にない）
    static wakeUp() {
        return new Subaru();
    }
}


// Viewの管理クラス
class View {
    static prevFrequency = 0;

    // 周波数を表示する
    static updateFrequency(frequency) {
        if (View.prevFrequency == frequency) {
            return;
        }
        View.prevFrequency = frequency;
        document.getElementById('frequency').textContent = Math.round(frequency) + " Hz" + View.frequencyToScale(frequency);
        if (frequency > 0) {
            document.getElementById('slider-bar').style.display = 'block';
            document.getElementById('slider-bar').style.top = "calc(" + View.frequencyToPos(frequency) + '% - 1.5px)';
        } else {
            document.getElementById('slider-bar').style.display = 'none';
        }
    }
    // 周波数をリセットする
    static resetFrequency(duck) {
        duck.setFrequency(0);
    }

    // デバッグ用： ログをJavaScriptのコンソールに表示する
    static log(message, showToUser = false) {
        console.log(message);
        if (showToUser) {
            document.getElementById('log').textContent = message;
        }
    }

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

    static onUserTouch(duck) {
        if (!duck.isModeSet() && duck.isEngineReady) {
            duck.switchToSliderMode();
            View.hideOverlay();
        }
    }

    // マウス・タッチイベントからモードを切り替える
    static onSliderMove(duck, pointedY) {
        if (duck.getMode() == Mode.SLIDER) {
            const frequencyBar = document.getElementById('slider');
            const rect = frequencyBar.getBoundingClientRect();
            const mouseY = pointedY - rect.top;
            const relativePosition = mouseY / frequencyBar.clientHeight;
            const frequency = View.posToFrequency(relativePosition);
            duck.setFrequency(frequency);
        }
    }

    // イベントリスナーをセット
    static setEventListeners(duck) {
        // かんたんモードと通常モードを切り替える
        document.getElementById('easy-mode').addEventListener('click', async () => {
            View.onUserTouch(duck);
            const container = document.getElementById('easy-mode-container');
            const sw = document.getElementById('easy-mode');
            if (sw.classList.contains('checked')) {
                duck.toggleEasyMode(false);
                sw.classList.remove('checked');
                container.classList.remove('checked');
            } else {
                duck.toggleEasyMode(true);
                sw.classList.add('checked');
                container.classList.add('checked');
            }
            View.hideOverlay();
        });
        // スライダーモードとオタマトーンモードを切り替える
        document.getElementById('otamatone-mode').addEventListener('click', async () => {
            const container = document.getElementById('otamatone-mode-container');
            const sw = document.getElementById('otamatone-mode');
            if (sw.classList.contains('checked')) {
                duck.switchToSliderMode();
                sw.classList.remove('checked');
                container.classList.remove('checked');
            } else {
                const result = await duck.switchToOtamatoneMode();
                console.log(result);
                if (result) {
                    sw.classList.add('checked');
                    container.classList.add('checked');
                }
            }
            View.hideOverlay();
        });

        // スライダー上のマウス・タッチ位置で周波数を設定する
        ['mouseover', 'mousemove'].forEach(eventType => {
            document.getElementById('slider').addEventListener(eventType, (event) => {
                View.onSliderMove(duck, event.clientY);
            });
        });
        document.getElementById('slider').addEventListener('touchstart', (event) => {
            View.onUserTouch(duck);
            event.preventDefault();
            if (event.changedTouches.length > 0) {
                View.onSliderMove(duck, event.changedTouches[0].clientY);
            }
        }, { passive: false });
        document.getElementById('slider').addEventListener('touchmove', (event) => {
            event.preventDefault(); // 画面スクロールの防止
            if (event.changedTouches.length > 0) {
                View.onSliderMove(duck, event.changedTouches[0].clientY);
            }
        }, { passive: false });
        // 指を当てたとき、話したとき、クリックしたとき、クリックを離したときなど、ユーザ操作があったら直ちにスライダーモードを起動する
        ['click', 'dblclick', 'mouseup', 'mousedown'].forEach(eventType => {
            document.getElementById('slider').addEventListener(eventType, () => {
                View.onUserTouch(duck);
            });
        });
        // 指を離したときに周波数を0にする
        document.getElementById('slider').addEventListener('touchend', () => {
            View.onUserTouch(duck);
            View.resetFrequency(duck);
        });
        // スライダーのマウスが外れたときに周波数を0にする。ただし子要素への移動は無視する。
        document.getElementById('slider').addEventListener('mouseout', (event) => {
            const related = event.relatedTarget;
            if (related && document.getElementById('slider').contains(related)) {
                return;
            }
            View.resetFrequency(duck);
        });
        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "hidden") {
                return;
            }
            duck.resume();
        });
        // ブラウザが閉じられたときにメモリを解放
        window.addEventListener('beforeunload', () => {
            duck.destruct();
        });
    }

    // オーバーレイを非表示にする
    static getReadyOverlay() {
        document.getElementById('overlay').textContent = '起こす';
        document.getElementById('easy-mode-container').classList.remove('isnotready');
        document.getElementById('easy-mode').classList.remove('isnotready');
        document.getElementById('otamatone-mode-container').classList.remove('isnotready');
        document.getElementById('otamatone-mode').classList.remove('isnotready');
    }
    // オーバーレイを表示する
    static hideOverlay() {
        document.getElementById('overlay').style.display = 'none';
    }
}
