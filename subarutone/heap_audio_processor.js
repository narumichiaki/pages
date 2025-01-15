import Module from './AudioEngine.js';

const DEBUG = true;
const BUFFER_LENGTH = 128; // 2025.01.10時点では変えられない https://developer.mozilla.org/ja/docs/Web/API/AudioWorkletProcessor/process

const Mode = {
    SLIDER: 'slider',
    OTAMATONE: 'otamatone'
};

class HeapAudioProcessor extends AudioWorkletProcessor {
    // スライダーモードのときに鳴らす周波数を受け取るためのAudioParamを定義
    static get parameterDescriptors() {
        return [{
            name: 'frequency',
            defaultValue: 0,
            automationRate: 'k-rate'
        }];
    }

    constructor() {
        super();
        this.isReady = false;
        this.isEasyMode = false;
        this.wasmInstance = null;
        this.mode = Mode.SLIDER;
        this.setMessageListener();
    }

    // メインアプリケーションからのメッセージの受信イベントをセット
    setMessageListener() {
        this.port.onmessage = (event) => {
            // メインアプリケーションから歌声合成エンジンと声のパラメータを受け取る
            if (event.data.type === "initialize") {
                this.initializeWasm(event.data.engine, event.data.voiceId, event.data.sampleRate);
            }
            // モード切り替え
            if (event.data.type === "mode") {
                if (event.data.mode === Mode.SLIDER) {
                    this.log("スライダーモードに切り替わりました。");
                    this.mode = Mode.SLIDER;
                }
                else if (event.data.mode === Mode.OTAMATONE) {
                    this.log("オタマトーンモードに切り替わりました。");
                    this.mode = Mode.OTAMATONE;
                }
                else {
                    this.error("モード指定が不正です： " + event.data.mode);
                }
            }
            if (event.data.type === 'easy-mode') {
                this.isEasyMode = event.data.isEasyMode;
                if (this.isEasyMode) {
                    this.log("かんたんモードに切り替わりました。");
                } else {
                    this.log("通常モードに切り替わりました。");
                }
            }
            // ブラウザが閉じられたときにメモリを解放
            if (event.data.type === 'destruct') {
                if (this.wasmInstance) {
                    this.wasmInstance._free(this.bufferPointer);
                    this.wasmInstance.destroy();
                }
            }
        };
    }
    
    // 歌声合成エンジンを初期化し、エンジンとの通信手段を確保
    async initializeWasm(wasmBinaryArray, voiceId, sampleRate) {
        this.log("歌声合成エンジンを初期化します。");
        try {
            const moduleArgs = {
                wasmBinaryArray: wasmBinaryArray,
                consoleLog: (message) => this.log(message, "[WASM] "), // WASMからのログ出力もブラウザに出ないので、メインプロセスにメッセージを渡すための関数をwasmに渡す
                debugLog: (message) => this.debug(message, "[WASM] ")
            };
            this.wasmInstance = await Module(moduleArgs);
            // 初期化
            const result = this.wasmInstance._initialize(sampleRate, BUFFER_LENGTH, voiceId);
            if (result === 0) {
                this.error("音声合成エンジンの初期化に失敗しました。");
                return;
            }
        } catch (e) {
            this.log(e);
        }
        // マイク(オタマトーン)からの入力音声を渡し、合成された歌声を返すためのメモリを確保 （直接は渡せないので、共有のメモリ領域にコピーする形で受け渡しする）
        this.bufferPointer = this.wasmInstance._malloc(BUFFER_LENGTH * Float32Array.BYTES_PER_ELEMENT);
        this.bufferOffset = this.bufferPointer / Float32Array.BYTES_PER_ELEMENT;
        this.isReady = true;
        this.log("歌声合成エンジンを初期化しました。");
        this.port.postMessage({ type: 'ready' });
    }

    // メインプロセスにログを送信（Workletからのconsole.logは表示されないため）
    log(message, header = "") {
        this.port.postMessage({ type: 'log', data: header + message });
    }
    // デバッグ用
    debug(message, header = "") {
        if (DEBUG) this.log(message, "[DEBUG] " + header);
    }
    // エラーを送信
    error(message, header = "") {
        this.port.postMessage({ type: 'error', data: header + message });
    }

    // メインループ： マイクからの音声入力を受け取り、そのままwasmに渡して、処理結果をスピーカーに出力
    process(inputs, outputs, parameters) {
        // 準備ができるまではメインループを起動しない (念のため)
        if (!this.isReady) return true;

        try {
            const input = inputs[0];   // マイク入力
            const output = outputs[0]; // スピーカー出力

            // オタマトーンモードのときはマイク入力をWASMに渡す
            if (this.mode == Mode.OTAMATONE && input.length > 0) {
                // マイク右側入力をWASMに渡す (オタマトーン付属ケーブルを用いてCTIA規格に対応したMac/iPhone/iPadに接続したときは、マイク右側にオタマトーンの音声が入る)
                this.wasmInstance.HEAPF32.set(input[0], this.bufferOffset);

                // 歌声合成エンジンの処理関数を呼び出してデータを変換
                const frequency = this.wasmInstance._processAudioData(this.bufferPointer, this.isEasyMode);
                this.port.postMessage({ type: 'frequency', frequency: Math.round(frequency) });
                
                // 出力音声信号をWASMからスピーカー出力にコピー (合成される音声はモノラル音源であるため、全てのチャンネルに同じデータをコピー)
                output.forEach(channel => {
                    channel.set(this.wasmInstance.HEAPF32.subarray(this.bufferOffset, this.bufferOffset + BUFFER_LENGTH));
                });
            }
            // スライダーモードのときはAudioParamから周波数を受け取り、その周波数の音声を生成
            else if (this.mode == Mode.SLIDER) {
                const frequency = this.wasmInstance._generateToneByFrequency(this.bufferPointer, parameters.frequency, this.isEasyMode);
                this.port.postMessage({ type: 'frequency', frequency: Math.round(frequency) });

                // 出力音声信号をWASMからスピーカー出力にコピー (モノラル音源であるため、全てのチャンネルに同じデータをコピー)
                output.forEach(channel => {
                    channel.set(this.wasmInstance.HEAPF32.subarray(this.bufferOffset, this.bufferOffset + BUFFER_LENGTH));
                });
            }

            return true;
        } catch (e) {
            this.log(e);
            return false;
        }
    }
}

// オーディオプロセッサを登録
registerProcessor('duck', HeapAudioProcessor);