// ============================================================================
// マイク録音（MediaRecorder）
// - recorderSupport(): 録音できる環境か（非 HTTPS・非対応をマイクを開く前に判定する）
// - startRecording(): マイクを開いて録音を始める。stop() で音声（Blob）を受け取り、cancel() で捨てる
//   開始に失敗したとき・止めたとき・捨てたとき・途中で止まったとき、開いたマイク（track）は必ず止める
//   （止め忘れると Android の「マイク使用中」の表示が残り、他のアプリも録音できなくなる）
// - RecorderError / recErrorMessage(): 失敗の種類と、利用者向けの案内（日本語）
// - createUrlBag(): 録音の object URL をまとめて持ち、画面を離れるときに一括で解放する
// 対象は Android の Chrome（audio/webm;codecs=opus）。使えなければ他の形式を順に試す。
// ============================================================================

/** 録音の失敗の種類 */
export type RecErrorKind = "denied" | "no-device" | "busy" | "insecure" | "unsupported" | "unknown";

export class RecorderError extends Error {
  readonly kind: RecErrorKind;
  /** 元の例外（DOMException など）。調査用 */
  readonly original: unknown;
  constructor(kind: RecErrorKind, original?: unknown) {
    super(`録音エラー: ${kind}`);
    this.name = "RecorderError";
    this.kind = kind;
    this.original = original;
  }
}

/** 使う形式の候補（先頭ほど優先）。Android の Chrome は先頭の webm/opus */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/**
 * dataavailable を出す間隔（ms）。
 * 区切って受け取っておくと、stop の後に onstop が来ない端末でも、そこまでの音声を返せる。
 */
const TIMESLICE_MS = 1000;

/** stop() の後、onstop を待つ上限（ms）。来なければ、受け取り済みの音声で打ち切る */
const STOP_TIMEOUT_MS = 3000;

/** 録音できる環境か。できなければ理由の種類を返す（マイクは開かない） */
export function recorderSupport(): { ok: true } | { ok: false; kind: RecErrorKind } {
  if (typeof window === "undefined" || typeof navigator === "undefined") return { ok: false, kind: "unsupported" };
  // 非 HTTPS では navigator.mediaDevices 自体が無い。先に判定して、案内を「HTTPS で開く」にする
  if (window.isSecureContext === false) return { ok: false, kind: "insecure" };
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return { ok: false, kind: "unsupported" };
  }
  if (typeof MediaRecorder === "undefined") return { ok: false, kind: "unsupported" };
  return { ok: true };
}

/** この端末で録音に使う形式（判定できなければ undefined = ブラウザに任せる） */
export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/** getUserMedia・MediaRecorder の例外を種類に分ける */
export function classifyRecorderError(e: unknown): RecErrorKind {
  if (e instanceof RecorderError) return e.kind;
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    // 権限の拒否（サイトの設定・Android のアプリ権限）。権限ポリシーで禁止されたときも同じ案内
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    // マイクが無い・条件に合うマイクが無い
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no-device";
    // 通話中・他のアプリが使用中などで開けない
    case "NotReadableError":
    case "TrackStartError":
      return "busy";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

/** 失敗の種類ごとの案内（画面にそのまま出す） */
export function recErrorMessage(kind: RecErrorKind): string {
  switch (kind) {
    case "denied":
      return "マイクの使用が許可されていません。アドレスバーの鍵アイコン（サイトの設定）→ 権限 でマイクを「許可」にしてください。ホーム画面のアプリから開いている場合は、Android の 設定 → アプリ → Chrome → 権限 → マイク も確認してください。";
    case "no-device":
      return "マイクが見つかりませんでした。マイク（イヤホンのマイクなど）がつながっているか確認してください。";
    case "busy":
      return "マイクを使えませんでした。通話中でないか、ほかのアプリ（録音・ビデオ通話など）がマイクを使っていないか確認してから、もう一度お試しください。";
    case "insecure":
      return "録音は HTTPS で開いたページでしか使えません。公開 URL（https://…）から開いてください。";
    case "unsupported":
      return "このブラウザは録音に対応していません。Android の Chrome を最新にしてお試しください。";
    default:
      return "録音できませんでした。もう一度お試しください。";
  }
}

/** 録音中の操作 */
export interface RecordingHandle {
  /**
   * 録音を止めて音声を返す（何度呼んでも同じ Promise）。マイクはここで閉じる。
   * 失敗したら RecorderError で reject する。
   */
  stop(): Promise<Blob>;
  /** 録音を捨ててマイクを閉じる（stop の後・途中で止まった後に呼んでもよい） */
  cancel(): void;
  /** 実際の形式（例: "audio/webm;codecs=opus"）。不明なら "" */
  readonly mimeType: string;
}

export interface StartRecordingOptions {
  /**
   * stop()・cancel() より前に録音が止まった（マイクを他のアプリに取られた・外れた等）。
   * このあと stop() を呼べば、そこまでの音声を受け取れる。
   */
  onInterrupt?: () => void;
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // すでに止まっている
    }
  });
}

/** MediaRecorder を作る。指定の形式で作れなければ、形式を指定せずに作り直す */
function createRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = pickRecorderMime();
  if (mimeType) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch {
      // 下で形式なしを試す
    }
  }
  return new MediaRecorder(stream);
}

/** 録音の状態を Promise とイベントでつなぐ。終わり方がどれでも track を止める */
function wire(rec: MediaRecorder, stream: MediaStream, opts: StartRecordingOptions): RecordingHandle {
  const chunks: Blob[] = [];
  /** 終わった（音声を返した・失敗した・捨てた） */
  let settled = false;
  /** stop() か cancel() を呼んだ（途中で止まったかの判定に使う） */
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (b: Blob) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Blob>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // stop() を呼ばないまま失敗・cancel しても、未処理の reject にしない（stop() の呼び出し側には届く）
  done.catch(() => {});

  const typeOf = () => rec.mimeType || pickRecorderMime() || "audio/webm";

  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    rec.ondataavailable = null;
    rec.onstop = null;
    rec.onerror = null;
    stopTracks(stream);
    if (error !== undefined) rejectDone(error instanceof RecorderError ? error : new RecorderError(classifyRecorderError(error), error));
    else resolveDone(new Blob(chunks, { type: typeOf() }));
    if (!requested) opts.onInterrupt?.();
  };

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  // マイクが外れた・取られたときも、ブラウザは録音を止めて stop を出す
  rec.onstop = () => finish();
  rec.onerror = (ev) => finish((ev as Event & { error?: unknown }).error ?? new RecorderError("unknown", ev));

  return {
    mimeType: rec.mimeType || "",
    stop() {
      if (!requested) {
        requested = true;
        if (!settled) {
          try {
            if (rec.state !== "inactive") rec.stop();
            else finish();
          } catch (e) {
            finish(e);
          }
          // onstop が来ない端末への保険: 受け取り済みの音声で打ち切る
          if (!settled) timer = setTimeout(() => finish(), STOP_TIMEOUT_MS);
        }
      }
      return done;
    },
    cancel() {
      requested = true;
      chunks.length = 0;
      if (settled) {
        stopTracks(stream);
        return;
      }
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        // すでに止まっている
      }
      finish(new DOMException("録音を取り消しました", "AbortError"));
    },
  };
}

/**
 * マイクを開いて録音を始める。
 * 環境が対応していない・権限が無い・マイクが無い等は RecorderError（kind つき）で reject する。
 * 開始までに失敗したら、開いたマイクは finally で必ず止める。
 */
export async function startRecording(opts: StartRecordingOptions = {}): Promise<RecordingHandle> {
  const sup = recorderSupport();
  if (!sup.ok) throw new RecorderError(sup.kind);
  let stream: MediaStream | null = null;
  let started = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = createRecorder(stream);
    const handle = wire(rec, stream, opts);
    rec.start(TIMESLICE_MS);
    started = true;
    return handle;
  } catch (e) {
    throw e instanceof RecorderError ? e : new RecorderError(classifyRecorderError(e), e);
  } finally {
    if (!started) stopTracks(stream);
  }
}

/** 録音の object URL の入れ物。画面を離れるときに revokeAll で一括解放する */
export interface UrlBag {
  /** Blob の URL を作って持つ */
  add(blob: Blob): string;
  /** 1つ解放する（この入れ物で作った URL だけ。null・未知の URL は無視） */
  revoke(url: string | null | undefined): void;
  /** すべて解放する */
  revokeAll(): void;
  /** 持っている URL の数 */
  readonly size: number;
}

export function createUrlBag(): UrlBag {
  const urls = new Set<string>();
  return {
    add(blob) {
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return url;
    },
    revoke(url) {
      if (!url || !urls.has(url)) return;
      urls.delete(url);
      URL.revokeObjectURL(url);
    },
    revokeAll() {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    },
    get size() {
      return urls.size;
    },
  };
}
