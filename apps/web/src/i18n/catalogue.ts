/**
 * The message catalogues (LOCALIZATION.md, Issue #58).
 *
 * Every locale is typed against **one** key union, so a locale missing an entry is a type error rather
 * than a runtime surprise found by a customer. Adding a key means adding it everywhere, which is the
 * intended friction: a half-translated screen is worse than an untranslated one, because nobody notices
 * the half.
 *
 * Keys are structural — named for what the string is, never for what it currently says or how it looks.
 * `setup.activate` survives a rewording; `setup.activateButtonBlue` does not survive a redesign.
 *
 * Plural entries carry the categories the locale actually has. Russian needs `one`, `few` and `many`;
 * English needs `one` and `other`. A catalogue that offered only English's categories would render
 * "22 сообщения" wrong in a way English never reveals, which is exactly the bug this shape prevents.
 */
import type { UiLocale } from "./locales";

export interface PluralForms {
  readonly one: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/** English: the fallback, and therefore the catalogue that defines the key set. */
const en = {
  "shell.skipToContent": "Skip to content",
  "shell.navigationLabel": "Workspace sections",
  "shell.openNavigation": "Sections",
  "shell.workspaceLabel": "Workspace",
  "shell.switchWorkspace": "Switch",
  "shell.setupLink": "Finish setup",
  "shell.localeLabel": "Interface language",
  "shell.localeSave": "Save",

  "nav.inbox": "Inbox",
  "nav.review": "Review",
  "nav.leads": "Leads",
  "nav.knowledge": "Knowledge",
  "nav.style": "Style",
  "nav.analytics": "Analytics",
  "nav.settings": "Settings",

  "step.WORKSPACE": "Workspace",
  "step.CHANNELS": "Connect channels",
  "step.AI_BEHAVIOUR": "What the AI should do",
  "step.KNOWLEDGE": "Knowledge",
  "step.STYLE": "Style",
  "step.TIMING_AND_HANDOFF": "Timing and handoff",
  "step.CHANNEL_POLICY": "Outside-window behaviour",
  "step.TEST_DRIVE": "Test before go-live",
  "step.ACTIVATION": "Activation",

  "stepDescription.WORKSPACE": "Your business and the profile this setup belongs to.",
  "stepDescription.CHANNELS": "Connect Instagram or WhatsApp. You can launch with one and add the other later.",
  "stepDescription.AI_BEHAVIOUR": "The goal, what counts as a qualified lead, and whether replies go out automatically.",
  "stepDescription.KNOWLEDGE": "The facts the assistant may rely on. Knowledge controls facts, not writing style.",
  "stepDescription.STYLE": "How replies should sound. Style examples never become factual authority.",
  "stepDescription.TIMING_AND_HANDOFF": "How quickly replies go out, and what happens after a person takes over.",
  "stepDescription.CHANNEL_POLICY": "What may be sent once a platform's messaging window has closed.",
  "stepDescription.TEST_DRIVE": "Try the assistant on a test conversation before any customer sees it.",
  "stepDescription.ACTIVATION": "Go live once the checklist below is clear.",

  "stepState.COMPLETE": "Done",
  "stepState.SKIPPED": "Skipped",
  "stepState.INCOMPLETE": "Not done yet",

  "channelReadiness.NOT_CONFIGURED": "Not connected",
  "channelReadiness.CONFIGURED": "Needs re-authorization",
  "channelReadiness.CONNECTED": "Connected, not replying",
  "channelReadiness.ELIGIBLE": "Ready, currently paused",
  "channelReadiness.SENDABLE": "Ready to reply",

  "channelReadinessDetail.NOT_CONFIGURED": "Connect this channel to start receiving conversations.",
  "channelReadinessDetail.CONFIGURED": "The connection expired or was revoked. Reconnect to keep answering customers.",
  "channelReadinessDetail.CONNECTED": "Messages arrive, but nothing is sent automatically — automation is off for this account.",
  "channelReadinessDetail.ELIGIBLE": "Everything is configured, but an operator has paused automated sending.",
  "channelReadinessDetail.SENDABLE": "Connected, configured, and able to reply now.",

  "blocker.NO_CONNECTED_CHANNEL": "Connect at least one channel and finish its authorization.",
  "blocker.NO_KNOWLEDGE": "Add the facts the assistant may rely on.",
  "blocker.NO_POLICY": "Choose what the assistant should do and how it should behave.",
  "blocker.UNRESOLVED_REVIEW_ITEMS": "Deal with the conversations already waiting for a person.",

  "channel.INSTAGRAM": "Instagram",
  "channel.WHATSAPP": "WhatsApp",

  "setup.title": "Set up your assistant",
  "setup.subtitle": "Nothing is sent to a customer until you activate.",
  "setup.resumeHint": "Next: {step}",
  "setup.allDone": "Every step is done.",
  "setup.checklistTitle": "Before you go live",
  "setup.checklistReady": "Everything on the checklist is clear.",
  "setup.activate": "Activate",
  "setup.activated": "This profile is live.",
  "setup.activationDenied": "Only an owner or admin can activate a profile.",
  "setup.skip": "Skip for now",
  "setup.undoSkip": "Do this after all",
  "setup.skipRestricted": "Only an owner or admin can change setup steps.",
  "setup.channelsTitle": "Channels",
  "setup.noChannels": "No channels are connected yet.",
  "setup.connectInstagram": "Connect Instagram",
  "setup.staleAction": "The setup changed while this page was open. It has been reloaded — please check and try again.",

  "connect.connected": "Instagram is connected.",
  "connect.denied": "The authorization was declined, so nothing changed.",
  "connect.expired": "That connection attempt timed out. Start it again.",
  "connect.invalid": "That connection attempt could not be verified. Start it again.",
  "connect.failed": "Instagram could not complete the connection. Start it again.",

  "landing.title": "Omnichannel AI Setter",
  "landing.lead": "Answer Instagram and WhatsApp customers with an assistant you control.",
  "landing.openWorkspaces": "Open your workspaces",

  "workspaces.title": "Choose a workspace",
  "workspaces.empty": "You are not a member of any workspace yet.",
  "workspaces.profilesTitle": "Choose a business profile",
  "workspaces.profilesEmpty": "This workspace has no business profiles yet.",
  "workspaces.role": "Your role: {role}",
  "profileStatus.ACTIVE": "Live",
  "profileStatus.SETUP": "In setup",
  "profileStatus.INACTIVE": "Inactive",

  "placeholder.comingSoon": "{section} arrives in a later task.",
  "placeholder.navigationOnly": "This page exists so the navigation is complete and keyboard-operable.",
} as const;

export type MessageKey = keyof typeof en;

/** A locale's catalogue: every key, or a plural entry where the key is plural. */
export type Catalogue = Readonly<Record<MessageKey, string>>;

const ru: Catalogue = {
  "shell.skipToContent": "Перейти к содержимому",
  "shell.navigationLabel": "Разделы рабочего пространства",
  "shell.openNavigation": "Разделы",
  "shell.workspaceLabel": "Рабочее пространство",
  "shell.switchWorkspace": "Сменить",
  "shell.setupLink": "Завершить настройку",
  "shell.localeLabel": "Язык интерфейса",
  "shell.localeSave": "Сохранить",

  "nav.inbox": "Входящие",
  "nav.review": "На проверку",
  "nav.leads": "Лиды",
  "nav.knowledge": "Знания",
  "nav.style": "Стиль",
  "nav.analytics": "Аналитика",
  "nav.settings": "Настройки",

  "step.WORKSPACE": "Рабочее пространство",
  "step.CHANNELS": "Подключение каналов",
  "step.AI_BEHAVIOUR": "Что должен делать ассистент",
  "step.KNOWLEDGE": "Знания",
  "step.STYLE": "Стиль",
  "step.TIMING_AND_HANDOFF": "Тайминг и передача человеку",
  "step.CHANNEL_POLICY": "Поведение вне окна ответа",
  "step.TEST_DRIVE": "Проверка перед запуском",
  "step.ACTIVATION": "Запуск",

  "stepDescription.WORKSPACE": "Ваш бизнес и профиль, к которому относится эта настройка.",
  "stepDescription.CHANNELS": "Подключите Instagram или WhatsApp. Можно запуститься с одним и добавить второй позже.",
  "stepDescription.AI_BEHAVIOUR": "Цель, что считается квалифицированным лидом, и уходят ли ответы автоматически.",
  "stepDescription.KNOWLEDGE": "Факты, на которые ассистент может опираться. Знания отвечают за факты, а не за стиль.",
  "stepDescription.STYLE": "Как должны звучать ответы. Примеры стиля никогда не становятся источником фактов.",
  "stepDescription.TIMING_AND_HANDOFF": "Как быстро уходят ответы и что происходит после того, как человек взял диалог.",
  "stepDescription.CHANNEL_POLICY": "Что можно отправлять после закрытия окна ответа платформы.",
  "stepDescription.TEST_DRIVE": "Попробуйте ассистента на тестовом диалоге, прежде чем его увидит клиент.",
  "stepDescription.ACTIVATION": "Запускайтесь, когда чек-лист ниже будет чистым.",

  "stepState.COMPLETE": "Готово",
  "stepState.SKIPPED": "Пропущено",
  "stepState.INCOMPLETE": "Пока не сделано",

  "channelReadiness.NOT_CONFIGURED": "Не подключён",
  "channelReadiness.CONFIGURED": "Нужна повторная авторизация",
  "channelReadiness.CONNECTED": "Подключён, не отвечает",
  "channelReadiness.ELIGIBLE": "Готов, сейчас на паузе",
  "channelReadiness.SENDABLE": "Готов отвечать",

  "channelReadinessDetail.NOT_CONFIGURED": "Подключите канал, чтобы начать получать диалоги.",
  "channelReadinessDetail.CONFIGURED": "Подключение истекло или было отозвано. Подключите заново, чтобы продолжать отвечать клиентам.",
  "channelReadinessDetail.CONNECTED": "Сообщения приходят, но ничего не отправляется автоматически — автоматизация для этого аккаунта выключена.",
  "channelReadinessDetail.ELIGIBLE": "Всё настроено, но оператор поставил автоматическую отправку на паузу.",
  "channelReadinessDetail.SENDABLE": "Подключён, настроен и может отвечать сейчас.",

  "blocker.NO_CONNECTED_CHANNEL": "Подключите хотя бы один канал и завершите его авторизацию.",
  "blocker.NO_KNOWLEDGE": "Добавьте факты, на которые ассистент может опираться.",
  "blocker.NO_POLICY": "Выберите, что должен делать ассистент и как себя вести.",
  "blocker.UNRESOLVED_REVIEW_ITEMS": "Разберитесь с диалогами, которые уже ждут человека.",

  "channel.INSTAGRAM": "Instagram",
  "channel.WHATSAPP": "WhatsApp",

  "setup.title": "Настройте ассистента",
  "setup.subtitle": "Пока вы не нажмёте «Запустить», клиенту ничего не уходит.",
  "setup.resumeHint": "Далее: {step}",
  "setup.allDone": "Все шаги пройдены.",
  "setup.checklistTitle": "Перед запуском",
  "setup.checklistReady": "Чек-лист чистый.",
  "setup.activate": "Запустить",
  "setup.activated": "Профиль работает.",
  "setup.activationDenied": "Запустить профиль может только владелец или администратор.",
  "setup.skip": "Пропустить пока",
  "setup.undoSkip": "Всё-таки сделать",
  "setup.skipRestricted": "Менять шаги настройки может только владелец или администратор.",
  "setup.channelsTitle": "Каналы",
  "setup.noChannels": "Каналы пока не подключены.",
  "setup.connectInstagram": "Подключить Instagram",
  "setup.staleAction": "Настройка изменилась, пока страница была открыта. Она перезагружена — проверьте и попробуйте снова.",

  "connect.connected": "Instagram подключён.",
  "connect.denied": "Авторизация отклонена, ничего не изменилось.",
  "connect.expired": "Эта попытка подключения истекла. Начните заново.",
  "connect.invalid": "Эту попытку подключения не удалось проверить. Начните заново.",
  "connect.failed": "Instagram не смог завершить подключение. Начните заново.",

  "landing.title": "Omnichannel AI Setter",
  "landing.lead": "Отвечайте клиентам в Instagram и WhatsApp ассистентом, который под вашим контролем.",
  "landing.openWorkspaces": "Открыть рабочие пространства",

  "workspaces.title": "Выберите рабочее пространство",
  "workspaces.empty": "Вы пока не участник ни одного рабочего пространства.",
  "workspaces.profilesTitle": "Выберите бизнес-профиль",
  "workspaces.profilesEmpty": "В этом рабочем пространстве пока нет бизнес-профилей.",
  "workspaces.role": "Ваша роль: {role}",
  "profileStatus.ACTIVE": "Работает",
  "profileStatus.SETUP": "В настройке",
  "profileStatus.INACTIVE": "Отключён",

  "placeholder.comingSoon": "Раздел «{section}» появится в следующей задаче.",
  "placeholder.navigationOnly": "Эта страница существует, чтобы навигация была полной и работала с клавиатуры.",
};

export const catalogues: Readonly<Record<UiLocale, Catalogue>> = { en, ru };

/**
 * Plural messages, kept separate because their shape is different.
 *
 * Only the entries a surface actually needs. An empty-looking category list is not an oversight: English
 * has two forms and Russian has four, and the formatter asks the locale which one applies rather than
 * guessing from the number.
 */
export const pluralCatalogues: Readonly<Record<UiLocale, Readonly<Record<string, PluralForms>>>> = {
  en: {
    "setup.reviewItemsWaiting": {
      one: "{count} conversation is waiting for a person.",
      other: "{count} conversations are waiting for a person.",
    },
    "setup.knowledgeDocuments": {
      one: "{count} knowledge source",
      other: "{count} knowledge sources",
    },
  },
  ru: {
    "setup.reviewItemsWaiting": {
      one: "{count} диалог ждёт человека.",
      few: "{count} диалога ждут человека.",
      many: "{count} диалогов ждут человека.",
      other: "{count} диалога ждут человека.",
    },
    "setup.knowledgeDocuments": {
      one: "{count} источник знаний",
      few: "{count} источника знаний",
      many: "{count} источников знаний",
      other: "{count} источника знаний",
    },
  },
};

export type PluralKey = keyof (typeof pluralCatalogues)["en"];
