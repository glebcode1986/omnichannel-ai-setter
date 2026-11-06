"use client";

/**
 * The browser half of WhatsApp Embedded Signup (ADR-015, Issue #19).
 *
 * Instagram connects with a form: our route answers `303` and the browser walks to Meta. WhatsApp
 * cannot. Meta's Embedded Signup returns its result to *our own page* through their JavaScript SDK, so
 * the route answers JSON and something here has to drive it: start the flow, open Meta's dialog, and
 * post back the code it hands over.
 *
 * Three decisions in this file are deliberate.
 *
 * **Meta's script is loaded on the click, not on the page.** It is a third-party script on an
 * authenticated console, so nothing fetches it until somebody actually asks to connect WhatsApp, and a
 * reader who never does never loads it.
 *
 * **Nothing here is told a secret.** The app id and the configuration id come back from our own route,
 * which read them from the server's environment; the app secret never leaves the server, and the code
 * Meta returns is posted straight back to our route without being stored or logged.
 *
 * **A failure says nothing was connected.** The route answers a fixed outcome token rather than
 * provider prose, and this shows one sentence: an operator needs to know whether to try again, not
 * which Graph error Meta chose.
 */
import { useCallback, useRef, useState } from "react";

export interface WhatsAppConnectLabels {
  readonly start: string;
  readonly working: string;
  readonly connected: string;
  readonly failed: string;
  readonly notConfigured: string;
}

export interface WhatsAppConnectProps {
  readonly connectPath: string;
  readonly completePath: string;
  readonly labels: WhatsAppConnectLabels;
}

/** What our own `/connect` route answers. Everything in it came from our server, not from Meta. */
interface StartedSignup {
  readonly status?: string;
  readonly state?: string;
  readonly launch?: {
    readonly appId?: string;
    readonly configId?: string;
    readonly graphVersion?: string;
  };
}

type Phase = "IDLE" | "WORKING" | "CONNECTED" | "FAILED" | "NOT_CONFIGURED";

/**
 * The three things this file calls on Meta's SDK, declared rather than cast.
 *
 * Typing only what is used is the point: a `window.FB: any` would let a later edit reach anything on a
 * third-party global without review.
 */
interface FacebookLoginResponse {
  readonly authResponse?: { readonly code?: string } | null;
}

interface FacebookSdk {
  init(options: { appId: string; version?: string | undefined; cookie?: boolean; xfbml?: boolean }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: { config_id: string; response_type: string; override_default_response_type: boolean },
  ): void;
}

/**
 * Meta's SDK as it is actually found: a property on `window` that may be anything, checked for the two
 * methods this file calls.
 *
 * Not `declare global`, for two reasons. The architecture checker refuses a global augmentation — it
 * cannot follow one statically — and a declaration would be a claim about a third-party script that
 * nothing verifies. A guard is a claim the code checks at the moment it matters.
 */
function sdkOnWindow(): FacebookSdk | undefined {
  const candidate: unknown = (window as unknown as Record<string, unknown>)["FB"];
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const shape = candidate as Partial<Record<"init" | "login", unknown>>;
  return typeof shape.init === "function" && typeof shape.login === "function" ? (candidate as FacebookSdk) : undefined;
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

/** Loads Meta's SDK once per document and resolves when `window.FB` exists. */
async function loadSdk(): Promise<FacebookSdk> {
  const existing = sdkOnWindow();
  if (existing !== undefined) {
    return existing;
  }
  await new Promise<void>((resolve, reject) => {
    const already = document.querySelector(`script[src="${SDK_SRC}"]`);
    if (already !== null) {
      already.addEventListener("load", () => {
        resolve();
      });
      already.addEventListener("error", () => {
        reject(new Error("sdk"));
      });
      return;
    }
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => {
      resolve();
    });
    script.addEventListener("error", () => {
      reject(new Error("sdk"));
    });
    document.head.appendChild(script);
  });
  const loaded = sdkOnWindow();
  if (loaded === undefined) {
    throw new Error("sdk");
  }
  return loaded;
}

export function WhatsAppConnect({ connectPath, completePath, labels }: WhatsAppConnectProps) {
  const [phase, setPhase] = useState<Phase>("IDLE");
  // One flow at a time: a second click while Meta's dialog is open would mint a second state row and
  // invalidate the first, so the operator would finish a signup our server no longer expects.
  const running = useRef(false);

  const connect = useCallback(async () => {
    if (running.current) {
      return;
    }
    running.current = true;
    setPhase("WORKING");
    try {
      const started = await fetch(connectPath, { method: "POST", headers: { accept: "application/json" } });
      if (started.status === 503) {
        setPhase("NOT_CONFIGURED");
        return;
      }
      if (!started.ok) {
        setPhase("FAILED");
        return;
      }
      const body = (await started.json()) as StartedSignup;
      // Read out once, so what was checked is what is used. Reaching back into `body.launch` inside the
      // callback below is also where the narrowing would be lost.
      const state = body.state;
      const appId = body.launch?.appId;
      const configId = body.launch?.configId;
      const graphVersion = body.launch?.graphVersion;
      if (state === undefined || appId === undefined || configId === undefined) {
        setPhase("FAILED");
        return;
      }

      const sdk = await loadSdk();
      sdk.init({ appId, version: graphVersion === "" ? undefined : graphVersion, cookie: false, xfbml: false });

      const code = await new Promise<string | undefined>((resolve) => {
        sdk.login(
          (response) => {
            resolve(response.authResponse?.code);
          },
          { config_id: configId, response_type: "code", override_default_response_type: true },
        );
      });
      if (code === undefined) {
        // The operator closed Meta's dialog. Nothing was connected and nothing needs saying.
        setPhase("IDLE");
        return;
      }

      const completed = await fetch(completePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, code }),
      });
      if (!completed.ok) {
        setPhase("FAILED");
        return;
      }
      setPhase("CONNECTED");
      // The card's state is server-rendered from the account that now exists, so the page is re-read
      // rather than patched here — one source for what is connected, which is the database.
      window.location.reload();
    } catch {
      setPhase("FAILED");
    } finally {
      running.current = false;
    }
  }, [connectPath, completePath]);

  if (phase === "NOT_CONFIGURED") {
    return (
      <p className="muted" data-whatsapp-connect="NOT_CONFIGURED">
        {labels.notConfigured}
      </p>
    );
  }

  return (
    <>
      <button
        className="button"
        data-variant="primary"
        data-connect="WHATSAPP"
        type="button"
        disabled={phase === "WORKING" || phase === "CONNECTED"}
        onClick={() => {
          void connect();
        }}
      >
        {phase === "WORKING" ? labels.working : phase === "CONNECTED" ? labels.connected : labels.start}
      </button>
      {phase === "FAILED" ? (
        <p className="notice" data-tone="stop" data-whatsapp-connect="FAILED">
          {labels.failed}
        </p>
      ) : undefined}
    </>
  );
}
