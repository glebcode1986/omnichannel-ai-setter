/**
 * Every string the shell shows a person, in one place.
 *
 * Not premature abstraction: P5-10 introduces the EN/RU localization foundation and MASTER #61 puts it
 * immediately after this task precisely so later UI can rely on it. Components that formatted their own
 * English inline would all have to be reopened. Keeping the text here means that task replaces one module
 * and changes no markup.
 *
 * The shapes are deliberately plain — records and functions returning strings — so nothing here presumes
 * which library eventually provides them.
 */
import type { ActivationBlocker, ChannelReadiness, OnboardingStep, OnboardingStepState } from "@omnichannel/domain";

export const NAV_SECTIONS = ["inbox", "review", "leads", "knowledge", "style", "analytics", "settings"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export const navLabels: Readonly<Record<NavSection, string>> = {
  inbox: "Inbox",
  review: "Review",
  leads: "Leads",
  knowledge: "Knowledge",
  style: "Style",
  analytics: "Analytics",
  settings: "Settings",
};

export const stepLabels: Readonly<Record<OnboardingStep, string>> = {
  WORKSPACE: "Workspace",
  CHANNELS: "Connect channels",
  AI_BEHAVIOUR: "What the AI should do",
  KNOWLEDGE: "Knowledge",
  STYLE: "Style",
  TIMING_AND_HANDOFF: "Timing and handoff",
  CHANNEL_POLICY: "Outside-window behaviour",
  TEST_DRIVE: "Test before go-live",
  ACTIVATION: "Activation",
};

/** What each step is for, in a sentence a non-technical owner can act on. */
export const stepDescriptions: Readonly<Record<OnboardingStep, string>> = {
  WORKSPACE: "Your business and the profile this setup belongs to.",
  CHANNELS: "Connect Instagram or WhatsApp. You can launch with one and add the other later.",
  AI_BEHAVIOUR: "The goal, what counts as a qualified lead, and whether replies go out automatically.",
  KNOWLEDGE: "The facts the assistant may rely on. Knowledge controls facts, not writing style.",
  STYLE: "How replies should sound. Style examples never become factual authority.",
  TIMING_AND_HANDOFF: "How quickly replies go out, and what happens after a person takes over.",
  CHANNEL_POLICY: "What may be sent once a platform's messaging window has closed.",
  TEST_DRIVE: "Try the assistant on a test conversation before any customer sees it.",
  ACTIVATION: "Go live once the checklist below is clear.",
};

export const stepStateLabels: Readonly<Record<OnboardingStepState, string>> = {
  COMPLETE: "Done",
  SKIPPED: "Skipped",
  INCOMPLETE: "Not done yet",
};

export const stepStateTones: Readonly<Record<OnboardingStepState, "ok" | "muted" | "warn">> = {
  COMPLETE: "ok",
  SKIPPED: "muted",
  INCOMPLETE: "warn",
};

/**
 * The four channel states, said in words a person can act on.
 *
 * The distinction the spec insists on only helps if the labels differ in meaning, not just in wording:
 * "connected" and "ready to reply" must not read as synonyms to someone deciding whether to launch.
 */
export const channelReadinessLabels: Readonly<Record<ChannelReadiness, string>> = {
  NOT_CONFIGURED: "Not connected",
  CONFIGURED: "Needs re-authorization",
  CONNECTED: "Connected, not replying",
  ELIGIBLE: "Ready, currently paused",
  SENDABLE: "Ready to reply",
};

export const channelReadinessExplanations: Readonly<Record<ChannelReadiness, string>> = {
  NOT_CONFIGURED: "Connect this channel to start receiving conversations.",
  CONFIGURED: "The connection expired or was revoked. Reconnect to keep answering customers.",
  CONNECTED: "Messages arrive, but nothing is sent automatically — automation is off for this account.",
  ELIGIBLE: "Everything is configured, but an operator has paused automated sending.",
  SENDABLE: "Connected, configured, and able to reply now.",
};

export const channelReadinessTones: Readonly<Record<ChannelReadiness, "ok" | "warn" | "stop" | "muted">> = {
  NOT_CONFIGURED: "muted",
  CONFIGURED: "stop",
  CONNECTED: "warn",
  ELIGIBLE: "warn",
  SENDABLE: "ok",
};

export const activationBlockerLabels: Readonly<Record<ActivationBlocker, string>> = {
  NO_CONNECTED_CHANNEL: "Connect at least one channel and finish its authorization.",
  NO_KNOWLEDGE: "Add the facts the assistant may rely on.",
  NO_POLICY: "Choose what the assistant should do and how it should behave.",
  UNRESOLVED_REVIEW_ITEMS: "Deal with the conversations already waiting for a person.",
};

export const channelLabels: Readonly<Record<string, string>> = {
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
};

export const shellText = {
  skipToContent: "Skip to content",
  navigationLabel: "Workspace sections",
  openNavigation: "Sections",
  workspaceLabel: "Workspace",
  profileLabel: "Business profile",
  switchWorkspace: "Switch",
  setupLink: "Finish setup",
} as const;

export const setupText = {
  title: "Set up your assistant",
  subtitle: "Nothing is sent to a customer until you activate.",
  resumeHint: (step: string) => `Next: ${step}`,
  allDone: "Every step is done.",
  checklistTitle: "Before you go live",
  checklistReady: "Everything on the checklist is clear.",
  activate: "Activate",
  activated: "This profile is live.",
  activationDenied: "Only an owner or admin can activate a profile.",
  skip: "Skip for now",
  undoSkip: "Do this after all",
  skipRestricted: "Only an owner or admin can change setup steps.",
  channelsTitle: "Channels",
  noChannels: "No channels are connected yet.",
  connectInstagram: "Connect Instagram",
  staleAction: "The setup changed while this page was open. It has been reloaded — please check and try again.",
} as const;

export const workspacePickerText = {
  title: "Choose a workspace",
  empty: "You are not a member of any workspace yet.",
  profilesTitle: "Choose a business profile",
  profilesEmpty: "This workspace has no business profiles yet.",
  roleLabel: (role: string) => `Your role: ${role.toLowerCase()}`,
  statusLabel: (status: string) => (status === "ACTIVE" ? "Live" : status === "SETUP" ? "In setup" : "Inactive"),
} as const;

export const placeholderText = {
  comingSoon: (section: string) => `${section} arrives in a later task.`,
  navigationOnly: "This page exists so the navigation is complete and keyboard-operable.",
} as const;
