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
  "blocker.STYLE_NOT_CONFIGURED": "Set the voice the assistant should use, or skip that step on purpose.",
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

  "inbox.searchLabel": "Search conversations",
  "inbox.searchPlaceholder": "Name or handle",
  "inbox.searchApply": "Search",
  "inbox.filtersLabel": "Filters",
  "inbox.filterAll": "All",
  "inbox.filterAwaitingReply": "Awaiting reply",
  "inbox.filterReviewNeeded": "Needs review",
  "inbox.filterHumanActive": "A person is handling",
  "inbox.filterMine": "Mine",
  "inbox.filterChannel": "Channel",
  "inbox.filterLeadStage": "Lead stage",
  "inbox.loadMore": "Load older conversations",
  "inbox.empty": "No conversations match this view.",
  "inbox.emptyUnfiltered": "Conversations appear here as customers write.",
  "inbox.listLabel": "Conversations",
  "inbox.threadLabel": "Conversation",
  "inbox.contextLabel": "Customer and assistant context",
  "inbox.chooseConversation": "Choose a conversation to read it.",
  "inbox.notFound": "That conversation is not in this business profile.",
  "inbox.threadEmpty": "No messages yet.",
  "inbox.awaitingReplyBadge": "Awaiting reply",
  "inbox.openDetails": "Show details",
  "inbox.hideDetails": "Hide details",
  "inbox.backToList": "Back to conversations",
  "inbox.loading": "Loading…",
  "inbox.stale": "This view was loaded a while ago. Reload to see the latest.",

  "inbox.allChannels": "Every channel",
  "inbox.allStages": "Every stage",
  "inbox.applyFilters": "Apply",
  "inbox.loadedAt": "Loaded at {time}",
  "inbox.reload": "Reload",
  "inbox.errorTitle": "The Inbox could not be loaded",
  "inbox.errorBody": "Nothing was sent to a customer. Try again, and tell us if it keeps happening.",
  "inbox.retry": "Try again",
  "context.modeOverridden": "Set for this conversation",
  "context.modeInherited": "From this channel's policy",
  "messageKind.TEXT": "Text",
  "messageKind.IMAGE": "Image",
  "messageKind.VIDEO": "Video",
  "messageKind.AUDIO": "Voice message",
  "messageKind.DOCUMENT": "Document",
  "messageKind.INTERACTIVE": "Button or list reply",
  "messageKind.TEMPLATE": "Template message",
  "messageKind.REACTION": "Reaction",
  "messageKind.UNKNOWN": "Unsupported attachment",

  "messageSource.PARTICIPANT": "Customer",
  "messageSource.AI": "Assistant",
  "messageSource.HUMAN": "Your team",
  "messageSource.AUTOMATION": "Automation",
  "messageSource.SYSTEM": "System",

  "deliveryStatus.PENDING": "Sending",
  "deliveryStatus.SENT": "Sent",
  "deliveryStatus.DELIVERED": "Delivered",
  "deliveryStatus.READ": "Read",
  "deliveryStatus.FAILED": "Not delivered",

  "transportPath.STANDARD": "Standard",
  "transportPath.HUMAN_AGENT": "Human support",

  "context.contactTitle": "Customer",
  "context.leadTitle": "Lead",
  "context.assistantTitle": "Latest assistant decision",
  "context.takeoverTitle": "Who is handling this",
  "context.channelTitle": "Channel",
  "context.noDecision": "The assistant has not drafted a reply here yet.",
  "context.confidence": "Confidence",
  "context.reasons": "Why it was held",
  "context.sources": "Facts it relied on",
  "context.noSources": "No stored facts were cited.",
  "context.intent": "Read as",
  "context.suggestedStage": "Suggested stage",
  "context.takeoverNone": "Nobody has taken this over.",
  "context.takeoverBy": "Held by {name}",
  "context.takeoverSince": "since {time}",
  "context.reviewQueued": "Queued for a person to review.",
  "context.lastInbound": "Customer last wrote",
  "context.lastOutbound": "We last replied",
  "context.never": "never",
  "context.reviewActionsLater": "Approving and editing arrive with the Review queue.",

  "accountStatus.CONNECTED": "Connected",
  "accountStatus.NEEDS_REAUTH": "Needs reconnecting",
  "accountStatus.DISCONNECTED": "Disconnected",
  "conversationStatus.OPEN": "Open",
  "conversationStatus.CLOSED": "Closed",
  "conversationStatus.ARCHIVED": "Archived",
  "context.cannotSend": "Replies cannot be sent until this channel is reconnected.",
  "leadStage.NEW": "New",
  "leadStage.ENGAGED": "Engaged",
  "leadStage.QUALIFYING": "Qualifying",
  "leadStage.QUALIFIED": "Qualified",
  "leadStage.BOOKED": "Booked",
  "leadStage.WON": "Won",
  "leadStage.LOST": "Lost",

  "aiMode.OFF": "Off",
  "aiMode.DRAFT": "Drafts only",
  "aiMode.AUTOPILOT": "Autopilot",

  "landing.title": "Omnichannel AI Setter",
  "landing.lead": "Answer Instagram and WhatsApp customers with an assistant you control.",
  "landing.openWorkspaces": "Open your workspaces",

  "workspaces.title": "Choose a workspace",
  "workspaces.empty": "You are not a member of any workspace yet.",
  "workspaces.profilesTitle": "Choose a business profile",
  "workspaces.profilesEmpty": "This workspace has no business profiles yet.",
  "workspaces.role": "Your role: {role}",
  "role.OWNER": "Owner",
  "role.ADMIN": "Admin",
  "role.AGENT": "Agent",
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
  "blocker.STYLE_NOT_CONFIGURED": "Задайте голос, которым будет говорить ассистент, или осознанно пропустите этот шаг.",
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

  "inbox.searchLabel": "Поиск по диалогам",
  "inbox.searchPlaceholder": "Имя или ник",
  "inbox.searchApply": "Найти",
  "inbox.filtersLabel": "Фильтры",
  "inbox.filterAll": "Все",
  "inbox.filterAwaitingReply": "Ждут ответа",
  "inbox.filterReviewNeeded": "Нужна проверка",
  "inbox.filterHumanActive": "Ведёт человек",
  "inbox.filterMine": "Мои",
  "inbox.filterChannel": "Канал",
  "inbox.filterLeadStage": "Стадия лида",
  "inbox.loadMore": "Показать более старые диалоги",
  "inbox.empty": "Под этот фильтр ничего не подходит.",
  "inbox.emptyUnfiltered": "Диалоги появятся здесь, когда напишут клиенты.",
  "inbox.listLabel": "Диалоги",
  "inbox.threadLabel": "Диалог",
  "inbox.contextLabel": "Контекст клиента и ассистента",
  "inbox.chooseConversation": "Выберите диалог, чтобы прочитать его.",
  "inbox.notFound": "Этого диалога нет в текущем бизнес-профиле.",
  "inbox.threadEmpty": "Сообщений пока нет.",
  "inbox.awaitingReplyBadge": "Ждёт ответа",
  "inbox.openDetails": "Показать детали",
  "inbox.hideDetails": "Скрыть детали",
  "inbox.backToList": "К списку диалогов",
  "inbox.loading": "Загрузка…",
  "inbox.stale": "Эта страница загружена давно. Обновите, чтобы увидеть актуальное.",

  "inbox.allChannels": "Все каналы",
  "inbox.allStages": "Все стадии",
  "inbox.applyFilters": "Применить",
  "inbox.loadedAt": "Загружено в {time}",
  "inbox.reload": "Обновить",
  "inbox.errorTitle": "Не удалось загрузить входящие",
  "inbox.errorBody": "Клиенту ничего не отправлено. Попробуйте снова и сообщите нам, если это повторится.",
  "inbox.retry": "Попробовать снова",
  "context.modeOverridden": "Задано для этого диалога",
  "context.modeInherited": "Из правил этого канала",
  "messageKind.TEXT": "Текст",
  "messageKind.IMAGE": "Изображение",
  "messageKind.VIDEO": "Видео",
  "messageKind.AUDIO": "Голосовое сообщение",
  "messageKind.DOCUMENT": "Документ",
  "messageKind.INTERACTIVE": "Ответ кнопкой или из списка",
  "messageKind.TEMPLATE": "Шаблонное сообщение",
  "messageKind.REACTION": "Реакция",
  "messageKind.UNKNOWN": "Неподдерживаемое вложение",

  "messageSource.PARTICIPANT": "Клиент",
  "messageSource.AI": "Ассистент",
  "messageSource.HUMAN": "Ваша команда",
  "messageSource.AUTOMATION": "Автоматика",
  "messageSource.SYSTEM": "Система",

  "deliveryStatus.PENDING": "Отправляется",
  "deliveryStatus.SENT": "Отправлено",
  "deliveryStatus.DELIVERED": "Доставлено",
  "deliveryStatus.READ": "Прочитано",
  "deliveryStatus.FAILED": "Не доставлено",

  "transportPath.STANDARD": "Обычная отправка",
  "transportPath.HUMAN_AGENT": "Поддержка человеком",

  "context.contactTitle": "Клиент",
  "context.leadTitle": "Лид",
  "context.assistantTitle": "Последнее решение ассистента",
  "context.takeoverTitle": "Кто ведёт диалог",
  "context.channelTitle": "Канал",
  "context.noDecision": "Ассистент пока не составлял здесь ответ.",
  "context.confidence": "Уверенность",
  "context.reasons": "Почему придержано",
  "context.sources": "На какие факты опирался",
  "context.noSources": "Сохранённые факты не использовались.",
  "context.intent": "Понято как",
  "context.suggestedStage": "Предложенная стадия",
  "context.takeoverNone": "Диалог никто не забирал.",
  "context.takeoverBy": "Ведёт {name}",
  "context.takeoverSince": "с {time}",
  "context.reviewQueued": "В очереди на проверку человеком.",
  "context.lastInbound": "Клиент писал",
  "context.lastOutbound": "Мы отвечали",
  "context.never": "никогда",
  "context.reviewActionsLater": "Одобрение и правка появятся вместе с очередью проверки.",

  "accountStatus.CONNECTED": "Подключён",
  "accountStatus.NEEDS_REAUTH": "Нужно переподключить",
  "accountStatus.DISCONNECTED": "Отключён",
  "conversationStatus.OPEN": "Открыт",
  "conversationStatus.CLOSED": "Закрыт",
  "conversationStatus.ARCHIVED": "В архиве",
  "context.cannotSend": "Ответы не будут отправляться, пока канал не переподключён.",
  "leadStage.NEW": "Новый",
  "leadStage.ENGAGED": "В диалоге",
  "leadStage.QUALIFYING": "Квалифицируется",
  "leadStage.QUALIFIED": "Квалифицирован",
  "leadStage.BOOKED": "Записан",
  "leadStage.WON": "Сделка",
  "leadStage.LOST": "Потерян",

  "aiMode.OFF": "Выключен",
  "aiMode.DRAFT": "Только черновики",
  "aiMode.AUTOPILOT": "Автопилот",

  "landing.title": "Omnichannel AI Setter",
  "landing.lead": "Отвечайте клиентам в Instagram и WhatsApp ассистентом, который под вашим контролем.",
  "landing.openWorkspaces": "Открыть рабочие пространства",

  "workspaces.title": "Выберите рабочее пространство",
  "workspaces.empty": "Вы пока не участник ни одного рабочего пространства.",
  "workspaces.profilesTitle": "Выберите бизнес-профиль",
  "workspaces.profilesEmpty": "В этом рабочем пространстве пока нет бизнес-профилей.",
  "workspaces.role": "Ваша роль: {role}",
  "role.OWNER": "Владелец",
  "role.ADMIN": "Администратор",
  "role.AGENT": "Оператор",
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
