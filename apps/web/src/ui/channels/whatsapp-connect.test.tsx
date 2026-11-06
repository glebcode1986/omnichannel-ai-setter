// @vitest-environment jsdom
/**
 * The browser half of WhatsApp Embedded Signup (ADR-015, Issue #19).
 *
 * What is covered here and what is not, stated plainly. Meta's dialog is not: it is their script, their
 * window and their account, and nothing in this repository can open it. Everything on *our* side of it
 * is — the two requests, the order they happen in, what is sent, and what the operator is told when
 * each of them refuses. `window.FB` is supplied by the test, so the flow runs end to end without the
 * script ever being fetched.
 *
 * The case that matters most is the deployment with no WhatsApp app. Our route answers `503` to that,
 * and a button that does so reads as our failure rather than as a missing app — so the card has to stop
 * being a button.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhatsAppConnect } from "./whatsapp-connect";

const LABELS = {
  start: "Connect WhatsApp",
  working: "Opening Meta…",
  connected: "Connected. Reloading…",
  failed: "That did not go through.",
  notConfigured: "This installation cannot connect this channel yet.",
};

const panel = () => render(<WhatsAppConnect connectPath="/c/start" completePath="/c/finish" labels={LABELS} />);

/** A `window.FB` that hands back whatever code the test wants, without fetching anything. */
function stubSdk(code: string | undefined): { init: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> } {
  const sdk = {
    init: vi.fn(),
    login: vi.fn((callback: (response: { authResponse?: { code?: string } | null }) => void) => {
      callback(code === undefined ? { authResponse: null } : { authResponse: { code } });
    }),
  };
  Object.defineProperty(window, "FB", { value: sdk, configurable: true, writable: true });
  return sdk;
}

const started = {
  status: "started",
  state: "st_1",
  launch: { appId: "app_1", configId: "cfg_1", graphVersion: "v26.0", scopes: [] },
};

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

/** The path a `fetch` call names, whichever of the three shapes it was given. */
const pathOf = (input: RequestInfo | URL): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** A request body, only where it is the string this component always sends. */
const bodyOf = (init: RequestInit | undefined): string => (typeof init?.body === "string" ? init.body : "");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "FB");
});

beforeEach(() => {
  // The page reloads itself on success — the card's state comes from the account that now exists, not
  // from anything patched in the browser — so the reload is stubbed rather than performed.
  Object.defineProperty(window, "location", { value: { reload: vi.fn() }, configurable: true, writable: true });
});

describe("a deployment that cannot offer WhatsApp", () => {
  it("stops being a button rather than offering one that refuses", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(answer(503, { status: "not_configured" }))));
    panel();

    await user.click(screen.getByRole("button", { name: LABELS.start }));

    await waitFor(() => {
      expect(screen.getByText(LABELS.notConfigured)).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: LABELS.start })).toBeNull();
    // And it never reached Meta: nothing was opened on an account we cannot finish connecting.
    expect(Reflect.get(window, "FB")).toBeUndefined();
  });
});

describe("the signup, from our side of it", () => {
  it("starts with our route, opens Meta with what that route returned, and posts the code back", async () => {
    const user = userEvent.setup();
    const sdk = stubSdk("code_1");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return Promise.resolve(pathOf(input) === "/c/start" ? answer(200, started) : answer(200, { status: "connected", channelAccountId: "ca_1" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    panel();

    await user.click(screen.getByRole("button", { name: LABELS.start }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    // Meta is initialised with the app the *server* named, never with anything compiled into the client.
    expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ appId: "app_1", version: "v26.0" }));
    expect(sdk.login).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ config_id: "cfg_1", response_type: "code" }));

    const [, options] = fetchMock.mock.calls[1] ?? [];
    expect(options?.method).toBe("POST");
    // The state the route minted travels back with the code, and nothing else does.
    expect(JSON.parse(bodyOf(options))).toEqual({ state: "st_1", code: "code_1" });
  });

  it("says nothing and stays offered when the operator closes Meta's dialog", async () => {
    const user = userEvent.setup();
    stubSdk(undefined);
    const fetchMock = vi.fn(() => Promise.resolve(answer(200, started)));
    vi.stubGlobal("fetch", fetchMock);
    panel();

    await user.click(screen.getByRole("button", { name: LABELS.start }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: LABELS.start })).toBeDefined();
    });
    // Closing a dialog is not a failure, and nothing was completed.
    expect(screen.queryByText(LABELS.failed)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says nothing was connected when the exchange refuses", async () => {
    const user = userEvent.setup();
    stubSdk("code_1");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => Promise.resolve(pathOf(input) === "/c/start" ? answer(200, started) : answer(400, { status: "expired" }))),
    );
    panel();

    await user.click(screen.getByRole("button", { name: LABELS.start }));

    await waitFor(() => {
      expect(screen.getByText(LABELS.failed)).toBeDefined();
    });
    // One sentence, and not the provider's. The route answers a fixed token; this shows a sentence.
    expect(screen.getByText(LABELS.failed).textContent).not.toContain("expired");
  });

  it("refuses to start a second flow while one is open", async () => {
    const user = userEvent.setup();
    // Meta's dialog never answers, which is what an operator staring at it looks like from here.
    Object.defineProperty(window, "FB", { value: { init: vi.fn(), login: vi.fn() }, configurable: true, writable: true });
    const fetchMock = vi.fn(() => Promise.resolve(answer(200, started)));
    vi.stubGlobal("fetch", fetchMock);
    panel();

    const button = screen.getByRole("button", { name: LABELS.start });
    await user.click(button);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: LABELS.working })).toBeDefined();
    });
    await user.click(screen.getByRole("button", { name: LABELS.working }));

    // A second start would mint a second state row and invalidate the first, so the operator would
    // finish a signup the server no longer expects.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders nothing that looks like a credential", () => {
    const { container } = panel();

    for (const forbidden of ["token", "secret", "appsecret", "Bearer"]) {
      expect(container.innerHTML.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
