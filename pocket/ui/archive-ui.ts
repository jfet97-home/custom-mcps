import * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import { normalizePocketTimestamp } from "../src/pocket-date.js"

interface RecordingRow {
  readonly recordingId: string
  readonly title: string | null
  readonly description: string | null
  readonly recordingAt: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly duration: number | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly snapshotCount: number
  readonly transcriptVersionCount: number
  readonly notesVersionCount: number
  readonly localNotesRevisionCount: number
}

interface Page<T> {
  readonly recordings?: ReadonlyArray<T>
  readonly versions?: ReadonlyArray<T>
  readonly revisions?: ReadonlyArray<T>
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number }
}

interface RecordingDetail {
  readonly recording: RecordingRow
}

interface TranscriptVersion {
  readonly versionId: number
  readonly transcriptionId: string
  readonly rowId: string
  readonly hash: string
  readonly capturedAt: string
  readonly source: string
  readonly updatedAt: string | null
  readonly textLength: number
  readonly segmentCount: number
}

interface NotesVersion {
  readonly versionId: number
  readonly summarizationId: string
  readonly rowId: string
  readonly hash: string
  readonly capturedAt: string
  readonly source: string
  readonly updatedAt: string | null
  readonly edited: boolean
  readonly textLength: number
  readonly localHead: { readonly revisionId: number; readonly hash: string; readonly capturedAt: string; readonly baseRemoteHash: string } | null
}

interface LocalNotesRevision {
  readonly revisionId: number
  readonly hash: string
  readonly previousHash: string
  readonly baseRemoteHash: string
  readonly capturedAt: string
  readonly textLength: number
}

interface DocumentPage {
  readonly version?: TranscriptVersion | NotesVersion
  readonly revision?: LocalNotesRevision
  readonly text?: string
  readonly markdown?: string
  readonly offset: number
  readonly returned: number
  readonly hasMore: boolean
}

interface LocalEditor {
  readonly summarizationId: string
  readonly source: "local" | "pocket"
  readonly expectedHash: string
  readonly baseRemoteHash: string
  readonly remoteHash: string
  readonly localRevisionId: number | null
  readonly changedRemotely: boolean
  readonly textLength: number
  readonly markdown: string | null
}

interface ViewedLocalRevision {
  readonly revisionId: number
  readonly markdown: string
  readonly offset: number
  readonly hasMore: boolean
  readonly loading: boolean
}

interface AppState {
  readonly authenticated: boolean
  readonly sessionStatus: string
  readonly query: string
  readonly recordings: ReadonlyArray<RecordingRow>
  readonly listTotal: number
  readonly listLoading: boolean
  readonly listError: string | null
  readonly selectedId: string | null
  readonly detail: RecordingDetail | null
  readonly detailLoading: boolean
  readonly transcriptVersions: ReadonlyArray<TranscriptVersion>
  readonly transcriptVersionsTotal: number
  readonly selectedTranscriptVersionId: number | null
  readonly transcriptText: string
  readonly transcriptOffset: number
  readonly transcriptHasMore: boolean
  readonly transcriptLoading: boolean
  readonly notesVersions: ReadonlyArray<NotesVersion>
  readonly notesVersionsTotal: number
  readonly selectedNotesVersionId: number | null
  readonly notesMarkdown: string
  readonly notesOffset: number
  readonly notesHasMore: boolean
  readonly notesLoading: boolean
  readonly editor: LocalEditor | null
  readonly editorHistory: ReadonlyArray<LocalNotesRevision>
  readonly editorHistoryTotal: number
  readonly editorHistoryLoading: boolean
  readonly viewedLocalRevision: ViewedLocalRevision | null
  readonly refreshLoading: boolean
  readonly saveLoading: boolean
  readonly notice: string | null
  readonly noticeWarning: boolean
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const apiPrefix = "/archive/api"
const stateAtom = Atom.make<AppState>({
  authenticated: false,
  sessionStatus: "Starting local session…",
  query: "",
  recordings: [],
  listTotal: 0,
  listLoading: false,
  listError: null,
  selectedId: null,
  detail: null,
  detailLoading: false,
  transcriptVersions: [],
  transcriptVersionsTotal: 0,
  selectedTranscriptVersionId: null,
  transcriptText: "",
  transcriptOffset: 0,
  transcriptHasMore: false,
  transcriptLoading: false,
  notesVersions: [],
  notesVersionsTotal: 0,
  selectedNotesVersionId: null,
  notesMarkdown: "",
  notesOffset: 0,
  notesHasMore: false,
  notesLoading: false,
  editor: null,
  editorHistory: [],
  editorHistoryTotal: 0,
  editorHistoryLoading: false,
  viewedLocalRevision: null,
  refreshLoading: false,
  saveLoading: false,
  notice: null,
  noticeWarning: false
})
const registry = AtomRegistry.make()
const editorDrafts = new Map<string, string>()
let noticeTimer = 0
let recordingSelectionGeneration = 0
let recordingListGeneration = 0
let transcriptVersionsGeneration = 0
let notesVersionsGeneration = 0
let transcriptPageGeneration = 0
let notesPageGeneration = 0
let editorRequestGeneration = 0
let localHistoryGeneration = 0
let localRevisionPageGeneration = 0
let requestedEditorKey: string | null = null

const state = (): AppState => registry.get(stateAtom)
const changeState = (patch: Partial<AppState> | ((current: AppState) => AppState)): void => {
  registry.update(stateAtom, (current) => typeof patch === "function" ? patch(current) : { ...current, ...patch })
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const button = (label: string, action: () => void, className = "button button-secondary button-small"): HTMLButtonElement => {
  const node = element("button", className, label)
  node.type = "button"
  node.addEventListener("click", action)
  return node
}

const formatDate = (value: string | null | undefined): string => {
  if (!value) return "Date not available"
  const date = new Date(normalizePocketTimestamp(value))
  if (!Number.isFinite(date.valueOf())) return "Date not available"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

const sourceLabel = (source: string): string => ({ backfill: "Imported", workflow: "Automatic", draft: "Local draft, not in Pocket", final: "Saved to Pocket" })[source] ?? "Saved"

const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "Duration unavailable"
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`
}

const api = async <T>(path: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> => {
  const headers: Record<string, string> = { "X-Pocket-UI": "1" }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${apiPrefix}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer"
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "The local archive request failed."
    throw new ApiError(error, response.status)
  }
  return body as T
}

const showNotice = (message: string, warning = false): void => {
  const notice = document.getElementById("notice")
  if (!notice) return
  notice.textContent = message
  notice.classList.toggle("warning", warning)
  notice.hidden = false
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.hidden = true }, 6500)
}

const sessionFailureMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 401) {
    return "Your local session expired. Open the archive again from the Pocket CLI; unsaved Notes text remains on this page."
  }
  return error instanceof Error ? error.message : "The local archive request failed."
}

const updateSessionBanner = (): void => {
  const current = state()
  const status = document.getElementById("session-status")
  const logout = document.getElementById("logout-button") as HTMLButtonElement | null
  if (status) status.textContent = current.sessionStatus
  if (logout) logout.hidden = !current.authenticated
}

const renderRecordingList = (): void => {
  const current = state()
  const list = document.getElementById("recording-list")
  const count = document.getElementById("recording-count")
  const loadMore = document.getElementById("load-recordings") as HTMLButtonElement | null
  if (!list || !count || !loadMore) return
  count.textContent = String(current.listTotal)
  list.replaceChildren()
  if (!current.authenticated) {
    const message = element("p", "list-empty", "Open this page with the Pocket CLI to start a private archive session.")
    list.append(message)
  } else if (current.listError) {
    list.append(element("p", "list-empty", current.listError))
  } else if (current.listLoading && current.recordings.length === 0) {
    list.append(element("p", "list-empty", "Loading saved recordings…"))
  } else if (current.recordings.length === 0) {
    list.append(element("p", "list-empty", "No saved recordings match this search."))
  }

  for (const recording of current.recordings) {
    const item = element("button", "recording-card")
    item.type = "button"
    item.setAttribute("aria-current", String(recording.recordingId === current.selectedId))
    item.addEventListener("click", () => { void loadRecording(recording.recordingId) })
    item.append(element("span", "recording-title", recording.title?.trim() || "Untitled recording"))
    item.append(element("span", "recording-meta", formatDate(recording.recordingAt ?? recording.createdAt)))
    item.append(element("span", "recording-counts", `${recording.transcriptVersionCount} transcript · ${recording.notesVersionCount} Notes · ${recording.localNotesRevisionCount} local edits`))
    list.append(item)
  }
  loadMore.hidden = current.recordings.length >= current.listTotal || !current.authenticated
  loadMore.disabled = current.listLoading
  loadMore.textContent = current.listLoading ? "Loading…" : "Load more recordings"
}

const makeSection = (title: string, hint: string, wide = false): { card: HTMLElement; body: HTMLElement } => {
  const card = element("section", wide ? "content-card content-card-wide" : "content-card")
  const heading = element("div", "card-heading")
  heading.append(element("h3", "", title), element("p", "", hint))
  const body = element("div", "card-body")
  card.append(heading, body)
  return { card, body }
}

const makeDocument = (text: string, className = "document-text"): HTMLElement => {
  const node = element("pre", className)
  node.textContent = text
  return node
}

const renderDetail = (): void => {
  const panel = document.getElementById("detail-panel")
  if (!panel) return
  const current = state()
  panel.replaceChildren()
  if (!current.authenticated) {
    const empty = element("div", "empty-state")
    empty.append(element("div", "empty-mark", "↗"), element("p", "eyebrow", "Local session required"), element("h2", "", "Open Pocket's local archive"), element("p", "", "Run `npm run archive:open` on this machine to create a private, short-lived browser session."))
    panel.append(empty)
    return
  }
  if (!current.selectedId || !current.detail) {
    const empty = element("div", "empty-state")
    empty.append(element("div", "empty-mark", "✳"), element("p", "eyebrow", "Your saved Pocket data"), element("h2", "", "Choose a recording"), element("p", "", "Browse the local archive without contacting Pocket. Use Refresh from Pocket when you want to add a newer snapshot."))
    panel.append(empty)
    return
  }

  const recording = current.detail.recording
  const header = element("header", "recording-header")
  header.append(element("p", "eyebrow", "Saved recording"), element("h2", "", recording.title?.trim() || "Untitled recording"))
  if (recording.description) header.append(element("p", "recording-description", recording.description))
  const metadata = element("div", "metadata-row")
  metadata.append(element("span", "metadata-pill", formatDate(recording.recordingAt ?? recording.createdAt)))
  metadata.append(element("span", "metadata-pill", formatDuration(recording.duration)))
  metadata.append(element("span", "metadata-pill", `Saved ${formatDate(recording.firstSeenAt)}`))
  header.append(metadata)
  const stats = element("div", "stats-row")
  stats.append(element("span", "stat-pill", `${recording.snapshotCount} saved snapshots`))
  stats.append(element("span", "stat-pill", `${recording.transcriptVersionCount} transcript versions`))
  stats.append(element("span", "stat-pill", `${recording.notesVersionCount} saved Notes versions`))
  stats.append(element("span", "stat-pill", `${recording.localNotesRevisionCount} local Notes revisions`))
  header.append(stats)
  panel.append(header)

  if (current.detailLoading) panel.append(element("p", "inline-message", "Loading local versions…"))
  const grid = element("div", "content-grid")
  grid.append(renderTranscripts(current), renderNotes(current), renderLocalEditor(current))
  panel.append(grid)
}

const renderTranscripts = (current: AppState): HTMLElement => {
  const section = makeSection("Transcript", "Saved transcript versions, newest first.")
  const list = element("div", "version-list")
  if (current.transcriptVersions.length === 0) list.append(element("p", "muted-copy", "No transcript versions are saved locally."))
  for (const version of current.transcriptVersions) {
    const item = element("button", "version-row")
    item.type = "button"
    item.setAttribute("aria-current", String(version.versionId === current.selectedTranscriptVersionId))
    item.addEventListener("click", () => { void selectTranscript(version.versionId) })
    const left = element("span")
    left.append(element("strong", "", formatDate(version.capturedAt)), element("small", "", `${version.segmentCount} segments · ${version.textLength.toLocaleString()} characters`))
    item.append(left, element("span", "version-tag", sourceLabel(version.source)))
    list.append(item)
  }
  section.body.append(list)
  if (current.transcriptVersions.length < current.transcriptVersionsTotal) {
    section.body.append(button("More transcript versions", () => { void loadTranscriptVersions(false) }, "button button-more button-small"))
  }
  if (current.selectedTranscriptVersionId !== null) {
    const toolbar = element("div", "document-toolbar")
    const version = current.transcriptVersions.find((item) => item.versionId === current.selectedTranscriptVersionId)
    toolbar.append(element("span", "document-meta", version ? `${version.textLength.toLocaleString()} characters` : ""))
    section.body.append(toolbar, makeDocument(current.transcriptText))
    if (current.transcriptHasMore) section.body.append(button(current.transcriptLoading ? "Loading…" : "Load next transcript page", () => { void loadTranscriptPage(false) }, "button button-more button-small"))
  } else if (current.transcriptLoading) {
    section.body.append(element("p", "muted-copy", "Loading local transcript…"))
  }
  return section.card
}

const renderNotes = (current: AppState): HTMLElement => {
  const section = makeSection("Notes history", "Captured Pocket versions and saved workflow drafts. Choose a version to inspect its text.")
  const list = element("div", "version-list")
  if (current.notesVersions.length === 0) list.append(element("p", "muted-copy", "No Notes versions are saved locally."))
  for (const version of current.notesVersions) {
    const item = element("button", "version-row")
    item.type = "button"
    item.setAttribute("aria-current", String(version.versionId === current.selectedNotesVersionId))
    item.addEventListener("click", () => { void selectNotes(version) })
    const left = element("span")
    left.append(element("strong", "", formatDate(version.updatedAt ?? version.capturedAt)), element("small", "", `${version.textLength.toLocaleString()} characters`))
    item.append(left, element("span", "version-tag", sourceLabel(version.source)))
    list.append(item)
  }
  section.body.append(list)
  if (current.notesVersions.length < current.notesVersionsTotal) {
    section.body.append(button("More Notes versions", () => { void loadNotesVersions(false) }, "button button-more button-small"))
  }
  if (current.selectedNotesVersionId !== null) {
    const toolbar = element("div", "document-toolbar")
    const version = current.notesVersions.find((item) => item.versionId === current.selectedNotesVersionId)
    toolbar.append(element("span", "document-meta", version ? `${version.textLength.toLocaleString()} characters · ${sourceLabel(version.source)}` : ""))
    section.body.append(toolbar, makeDocument(current.notesMarkdown))
    if (current.notesHasMore) section.body.append(button(current.notesLoading ? "Loading…" : "Load next Notes page", () => { void loadNotesPage(false) }, "button button-more button-small"))
  } else if (current.notesLoading) {
    section.body.append(element("p", "muted-copy", "Loading local Notes…"))
  }
  return section.card
}

const renderLocalEditor = (current: AppState): HTMLElement => {
  const section = makeSection("Local Notes", "Edit a private revision. Saving here never uploads to Pocket.", true)
  const editor = current.editor
  if (!editor) {
    section.body.append(element("p", "muted-copy", current.notesVersions.length === 0 ? "Save a Pocket snapshot before editing local Notes." : "Loading the current Notes source…"))
    return section.card
  }
  const status = element("div", "button-row")
  status.append(element("span", "local-badge", editor.source === "local" ? `Saved locally · revision ${editor.localRevisionId}` : "Editing a local copy"))
  if (editor.changedRemotely) status.append(element("span", "local-badge stale-badge", "Pocket has a newer saved version"))
  section.body.append(status)
  if (editor.markdown === null) {
    section.body.append(element("p", "inline-message warning", "This Notes version is larger than the local editor limit. You can still read it in the paged history above."))
    return section.card
  }
  const textarea = element("textarea", "notes-editor")
  textarea.id = "local-notes-editor"
  textarea.setAttribute("aria-label", "Local Notes Markdown")
  textarea.spellcheck = true
  const editorKey = `${current.selectedId}:${editor.summarizationId}`
  const draft = editorDrafts.get(editorKey) ?? editor.markdown
  textarea.value = draft
  textarea.addEventListener("input", () => {
    editorDrafts.set(editorKey, textarea.value)
    const editorStatus = document.getElementById("editor-status")
    if (editorStatus) editorStatus.textContent = textarea.value === editor.markdown ? "No unsaved local changes." : "Unsaved local changes."
    save.disabled = current.saveLoading || textarea.value === editor.markdown
  })
  section.body.append(textarea)
  const editorStatus = element("p", "editor-status")
  editorStatus.id = "editor-status"
  editorStatus.textContent = draft === editor.markdown ? "No unsaved local changes." : "Unsaved local changes."
  section.body.append(editorStatus)
  const actions = element("div", "button-row")
  const save = button(current.saveLoading ? "Saving locally…" : "Save local revision", () => { void saveLocalNotes() }, "button button-primary button-small")
  save.disabled = current.saveLoading || draft === editor.markdown
  actions.append(save, element("span", "muted-copy", "Only this SQLite archive changes."))
  section.body.append(actions)

  const history = element("details", "history-details")
  history.open = true
  history.append(element("summary", "", `Local revision history · ${current.editorHistoryTotal}`))
  const historyList = element("div", "history-list")
  if (current.editorHistoryLoading) historyList.append(element("p", "muted-copy", "Loading local revisions…"))
  if (current.editorHistory.length === 0 && !current.editorHistoryLoading) historyList.append(element("p", "muted-copy", "No local revisions saved yet."))
  for (const revision of current.editorHistory) {
    const entry = button("", () => { void viewLocalRevision(revision.revisionId) }, "history-entry")
    const label = element("span", "", `Revision ${revision.revisionId}`)
    label.append(element("small", "", `${formatDate(revision.capturedAt)} · ${revision.textLength.toLocaleString()} characters`))
    entry.append(label, element("span", "version-tag", "Local"))
    historyList.append(entry)
  }
  if (current.editorHistory.length < current.editorHistoryTotal) historyList.append(button("More local revisions", () => { void loadLocalHistory(false) }, "button button-more button-small"))
  history.append(historyList)
  if (current.viewedLocalRevision) {
    const viewed = current.viewedLocalRevision
    const revision = current.editorHistory.find((item) => item.revisionId === viewed.revisionId)
    const detail = element("details", "history-details")
    detail.open = true
    detail.append(element("summary", "", `Revision ${viewed.revisionId} · ${revision?.textLength.toLocaleString() ?? ""} characters`))
    if (viewed.loading && !viewed.markdown) detail.append(element("p", "muted-copy", "Loading local revision…"))
    else detail.append(makeDocument(viewed.markdown))
    if (viewed.hasMore) detail.append(button(viewed.loading ? "Loading…" : "Load next revision page", () => { void loadLocalRevisionPage(true) }, "button button-more button-small"))
    history.append(detail)
  }
  section.body.append(history)
  return section.card
}

const render = (): void => {
  const activeEditor = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.id === "local-notes-editor"
    ? document.activeElement
    : null
  const editorSelection = activeEditor ? {
    start: activeEditor.selectionStart,
    end: activeEditor.selectionEnd,
    direction: activeEditor.selectionDirection,
    scrollTop: activeEditor.scrollTop
  } : null
  updateSessionBanner()
  renderRecordingList()
  renderDetail()
  const refresh = document.getElementById("refresh-button") as HTMLButtonElement | null
  if (refresh) refresh.disabled = !state().authenticated || !state().selectedId || state().refreshLoading
  const notice = document.getElementById("notice")
  const current = state()
  if (notice && current.notice) {
    notice.textContent = current.notice
    notice.classList.toggle("warning", current.noticeWarning)
    notice.hidden = false
  }
  if (editorSelection) {
    const nextEditor = document.getElementById("local-notes-editor") as HTMLTextAreaElement | null
    if (nextEditor) {
      nextEditor.focus({ preventScroll: true })
      nextEditor.setSelectionRange(editorSelection.start, editorSelection.end, editorSelection.direction ?? undefined)
      nextEditor.scrollTop = editorSelection.scrollTop
    }
  }
}

const isCurrentRecording = (recordingId: string, generation: number): boolean =>
  recordingSelectionGeneration === generation && state().selectedId === recordingId

const listPath = (query: string, offset: number): string => {
  const params = new URLSearchParams({ limit: "20", offset: String(offset) })
  if (query) params.set("q", query)
  return `/recordings?${params.toString()}`
}

const loadRecordings = async (replace: boolean): Promise<void> => {
  const current = state()
  const offset = replace ? 0 : current.recordings.length
  const query = current.query
  const generation = ++recordingListGeneration
  changeState({ listLoading: true, listError: null })
  try {
    const page = await api<Page<RecordingRow>>(listPath(query, offset))
    if (generation !== recordingListGeneration || state().query !== query) return
    const incoming = page.recordings ?? []
    changeState((latest) => ({
      ...latest,
      listLoading: false,
      recordings: replace ? incoming : [...latest.recordings, ...incoming],
      listTotal: page.pagination.total
    }))
  } catch (error) {
    if (generation !== recordingListGeneration || state().query !== query) return
    changeState({ listLoading: false, listError: sessionFailureMessage(error), sessionStatus: error instanceof ApiError && error.status === 401 ? "Session expired" : "Archive unavailable" })
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadTranscriptVersions = async (
  replace: boolean,
  recordingId = state().selectedId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  if (!recordingId) return
  const requestGeneration = ++transcriptVersionsGeneration
  const offset = replace ? 0 : state().transcriptVersions.length
  try {
    const page = await api<Page<TranscriptVersion>>(`/recordings/${encodeURIComponent(recordingId)}/transcripts?limit=20&offset=${offset}`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== transcriptVersionsGeneration) return
    const incoming = page.versions ?? []
    const latest = state()
    const versions = replace ? incoming : [...latest.transcriptVersions, ...incoming]
    const first = replace ? incoming[0] : undefined
    changeState({
      transcriptVersions: versions,
      transcriptVersionsTotal: page.pagination.total,
      selectedTranscriptVersionId: replace ? first?.versionId ?? null : latest.selectedTranscriptVersionId
    })
    if (first) await loadTranscriptPage(true, first.versionId, recordingId, selectionGeneration)
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== transcriptVersionsGeneration) return
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadNotesVersions = async (
  replace: boolean,
  recordingId = state().selectedId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  if (!recordingId) return
  const requestGeneration = ++notesVersionsGeneration
  const offset = replace ? 0 : state().notesVersions.length
  try {
    const page = await api<Page<NotesVersion>>(`/recordings/${encodeURIComponent(recordingId)}/notes?limit=20&offset=${offset}`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== notesVersionsGeneration) return
    const incoming = page.versions ?? []
    const latest = state()
    const versions = replace ? incoming : [...latest.notesVersions, ...incoming]
    const first = replace ? incoming[0] : undefined
    changeState({
      notesVersions: versions,
      notesVersionsTotal: page.pagination.total,
      selectedNotesVersionId: replace ? first?.versionId ?? null : latest.selectedNotesVersionId
    })
    if (first) {
      await loadNotesPage(true, first.versionId, recordingId, selectionGeneration)
      if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== notesVersionsGeneration) return
      await loadEditor(first.summarizationId, recordingId, selectionGeneration)
    }
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== notesVersionsGeneration) return
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadRecording = async (recordingId: string): Promise<void> => {
  const selectionGeneration = ++recordingSelectionGeneration
  transcriptVersionsGeneration += 1
  notesVersionsGeneration += 1
  transcriptPageGeneration += 1
  notesPageGeneration += 1
  editorRequestGeneration += 1
  localHistoryGeneration += 1
  localRevisionPageGeneration += 1
  requestedEditorKey = null
  changeState({
    selectedId: recordingId, detail: null, detailLoading: true,
    transcriptVersions: [], transcriptVersionsTotal: 0, selectedTranscriptVersionId: null,
    transcriptText: "", transcriptOffset: 0, transcriptHasMore: false, transcriptLoading: false,
    notesVersions: [], notesVersionsTotal: 0, selectedNotesVersionId: null,
    notesMarkdown: "", notesOffset: 0, notesHasMore: false, notesLoading: false,
    editor: null, editorHistory: [], editorHistoryTotal: 0, editorHistoryLoading: false,
    viewedLocalRevision: null, saveLoading: false, refreshLoading: false
  })
  const encoded = encodeURIComponent(recordingId)
  try {
    const [detail] = await Promise.all([
      api<RecordingDetail>(`/recordings/${encoded}`),
      loadTranscriptVersions(true, recordingId, selectionGeneration),
      loadNotesVersions(true, recordingId, selectionGeneration)
    ])
    if (!isCurrentRecording(recordingId, selectionGeneration)) return
    changeState({ detail, detailLoading: false })
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration)) return
    changeState({ detailLoading: false })
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadTranscriptPage = async (
  append: boolean,
  versionId = state().selectedTranscriptVersionId,
  recordingId = state().selectedId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  const current = state()
  if (!recordingId || versionId === null) return
  const requestGeneration = ++transcriptPageGeneration
  const offset = append ? current.transcriptOffset : 0
  changeState({ transcriptLoading: true, selectedTranscriptVersionId: versionId })
  try {
    const page = await api<DocumentPage>(`/recordings/${encodeURIComponent(recordingId)}/transcripts/${versionId}?offset=${offset}&limit=12000`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== transcriptPageGeneration || state().selectedTranscriptVersionId !== versionId) return
    changeState((latest) => ({
      ...latest,
      transcriptLoading: false,
      transcriptText: append ? latest.transcriptText + (page.text ?? "") : page.text ?? "",
      transcriptOffset: offset + page.returned,
      transcriptHasMore: page.hasMore
    }))
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== transcriptPageGeneration || state().selectedTranscriptVersionId !== versionId) return
    changeState({ transcriptLoading: false })
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadNotesPage = async (
  append: boolean,
  versionId = state().selectedNotesVersionId,
  recordingId = state().selectedId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  const current = state()
  if (!recordingId || versionId === null) return
  const requestGeneration = ++notesPageGeneration
  const offset = append ? current.notesOffset : 0
  changeState({ notesLoading: true, selectedNotesVersionId: versionId })
  try {
    const page = await api<DocumentPage>(`/recordings/${encodeURIComponent(recordingId)}/notes/${versionId}?offset=${offset}&limit=12000`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== notesPageGeneration || state().selectedNotesVersionId !== versionId) return
    changeState((latest) => ({
      ...latest,
      notesLoading: false,
      notesMarkdown: append ? latest.notesMarkdown + (page.markdown ?? "") : page.markdown ?? "",
      notesOffset: offset + page.returned,
      notesHasMore: page.hasMore
    }))
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== notesPageGeneration || state().selectedNotesVersionId !== versionId) return
    changeState({ notesLoading: false })
    showNotice(sessionFailureMessage(error), true)
  }
}

const selectTranscript = async (versionId: number): Promise<void> => {
  changeState({ transcriptText: "", transcriptOffset: 0, transcriptHasMore: false, selectedTranscriptVersionId: versionId })
  await loadTranscriptPage(false, versionId)
}

const selectNotes = async (version: NotesVersion): Promise<void> => {
  const recordingId = state().selectedId
  if (!recordingId) return
  const selectionGeneration = recordingSelectionGeneration
  notesPageGeneration += 1
  editorRequestGeneration += 1
  localHistoryGeneration += 1
  localRevisionPageGeneration += 1
  requestedEditorKey = null
  changeState({
    notesMarkdown: "", notesOffset: 0, notesHasMore: false, selectedNotesVersionId: version.versionId,
    notesLoading: false, editor: null, editorHistory: [], editorHistoryTotal: 0, editorHistoryLoading: false,
    viewedLocalRevision: null, saveLoading: false
  })
  await Promise.all([
    loadNotesPage(false, version.versionId, recordingId, selectionGeneration),
    loadEditor(version.summarizationId, recordingId, selectionGeneration)
  ])
}

const editorPath = (recordingId: string, summarizationId: string): string =>
  `/recordings/${encodeURIComponent(recordingId)}/local-notes/${encodeURIComponent(summarizationId)}`

const loadEditor = async (
  summarizationId: string,
  recordingId = state().selectedId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  if (!recordingId) return
  const key = `${recordingId}:${summarizationId}`
  const requestGeneration = ++editorRequestGeneration
  requestedEditorKey = key
  try {
    const [editor, history] = await Promise.all([
      api<LocalEditor>(editorPath(recordingId, summarizationId)),
      api<Page<LocalNotesRevision>>(`${editorPath(recordingId, summarizationId)}/history?limit=20&offset=0`)
    ])
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== editorRequestGeneration || requestedEditorKey !== key) return
    if (!editorDrafts.has(key)) editorDrafts.set(key, editor.markdown ?? "")
    changeState({ editor, editorHistory: history.revisions ?? [], editorHistoryTotal: history.pagination.total, editorHistoryLoading: false, viewedLocalRevision: null })
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== editorRequestGeneration || requestedEditorKey !== key) return
    changeState({ editorHistoryLoading: false })
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadLocalHistory = async (
  replace: boolean,
  recordingId = state().selectedId,
  summarizationId = state().editor?.summarizationId,
  selectionGeneration = recordingSelectionGeneration
): Promise<void> => {
  const current = state()
  if (!recordingId || !summarizationId || !current.editor) return
  const offset = replace ? 0 : current.editorHistory.length
  const requestGeneration = ++localHistoryGeneration
  changeState({ editorHistoryLoading: true })
  try {
    const page = await api<Page<LocalNotesRevision>>(`${editorPath(recordingId, summarizationId)}/history?limit=20&offset=${offset}`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localHistoryGeneration || state().editor?.summarizationId !== summarizationId) return
    changeState((latest) => ({
      ...latest,
      editorHistoryLoading: false,
      editorHistory: replace ? page.revisions ?? [] : [...latest.editorHistory, ...(page.revisions ?? [])],
      editorHistoryTotal: page.pagination.total
    }))
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localHistoryGeneration || state().editor?.summarizationId !== summarizationId) return
    changeState({ editorHistoryLoading: false })
    showNotice(sessionFailureMessage(error), true)
  }
}

const viewLocalRevision = async (revisionId: number): Promise<void> => {
  const current = state()
  const recordingId = current.selectedId
  const editor = current.editor
  if (!recordingId || !editor) return
  const path = `${editorPath(recordingId, editor.summarizationId)}/history/${revisionId}`
  const selectionGeneration = recordingSelectionGeneration
  const requestGeneration = ++localRevisionPageGeneration
  changeState({ viewedLocalRevision: { revisionId, markdown: "", offset: 0, hasMore: false, loading: true } })
  try {
    const page = await api<DocumentPage>(`${path}?offset=0&limit=12000`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localRevisionPageGeneration || state().editor?.summarizationId !== editor.summarizationId) return
    changeState({ viewedLocalRevision: { revisionId, markdown: page.markdown ?? "", offset: page.returned, hasMore: page.hasMore, loading: false } })
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localRevisionPageGeneration || state().editor?.summarizationId !== editor.summarizationId) return
    changeState({ viewedLocalRevision: { revisionId, markdown: "", offset: 0, hasMore: false, loading: false } })
    showNotice(sessionFailureMessage(error), true)
  }
}

const loadLocalRevisionPage = async (append: boolean): Promise<void> => {
  const current = state()
  const recordingId = current.selectedId
  const editor = current.editor
  const viewed = current.viewedLocalRevision
  if (!recordingId || !editor || !viewed || viewed.loading || !viewed.hasMore && append) return
  const selectionGeneration = recordingSelectionGeneration
  const requestGeneration = ++localRevisionPageGeneration
  const offset = append ? viewed.offset : 0
  const path = `${editorPath(recordingId, editor.summarizationId)}/history/${viewed.revisionId}`
  changeState({ viewedLocalRevision: { ...viewed, loading: true } })
  try {
    const page = await api<DocumentPage>(`${path}?offset=${offset}&limit=12000`)
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localRevisionPageGeneration || state().editor?.summarizationId !== editor.summarizationId || state().viewedLocalRevision?.revisionId !== viewed.revisionId) return
    changeState({ viewedLocalRevision: {
      ...viewed, markdown: append ? viewed.markdown + (page.markdown ?? "") : page.markdown ?? "",
      offset: offset + page.returned, hasMore: page.hasMore, loading: false
    } })
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration) || requestGeneration !== localRevisionPageGeneration || state().viewedLocalRevision?.revisionId !== viewed.revisionId) return
    changeState({ viewedLocalRevision: { ...viewed, loading: false } })
    showNotice(sessionFailureMessage(error), true)
  }
}

const saveLocalNotes = async (): Promise<void> => {
  const current = state()
  const editor = current.editor
  const recordingId = current.selectedId
  const editorKey = editor && recordingId ? `${recordingId}:${editor.summarizationId}` : ""
  const selectionGeneration = recordingSelectionGeneration
  const markdown = (document.getElementById("local-notes-editor") as HTMLTextAreaElement | null)?.value ?? editorDrafts.get(editorKey)
  if (!editor || !recordingId || markdown === undefined) return
  editorDrafts.set(editorKey, markdown)
  if (markdown === editor.markdown) return
  changeState({ saveLoading: true })
  try {
    const result = await api<{ revisionId: number; hash: string; previousHash: string; baseRemoteHash: string; capturedAt: string }>(
      editorPath(recordingId, editor.summarizationId), { method: "PUT", body: { expectedHash: editor.expectedHash, markdown } }
    )
    if (isCurrentRecording(recordingId, selectionGeneration) && state().editor?.summarizationId === editor.summarizationId) {
      changeState((latest) => ({
        ...latest,
        saveLoading: false,
        editor: latest.editor ? {
          ...latest.editor, source: "local", expectedHash: result.hash, baseRemoteHash: result.baseRemoteHash,
          localRevisionId: result.revisionId, changedRemotely: latest.editor.remoteHash !== result.baseRemoteHash,
          textLength: markdown.length, markdown
        } : latest.editor
      }))
      await loadLocalHistory(true, recordingId, editor.summarizationId, selectionGeneration)
    }
    showNotice("Local Notes revision saved in this archive. Pocket was not changed.")
  } catch (error) {
    if (isCurrentRecording(recordingId, selectionGeneration) && state().editor?.summarizationId === editor.summarizationId) {
      changeState({ saveLoading: false, sessionStatus: error instanceof ApiError && error.status === 401 ? "Session expired" : state().sessionStatus })
    }
    showNotice(sessionFailureMessage(error), true)
  }
}

const refreshFromPocket = async (): Promise<void> => {
  const recordingId = state().selectedId
  if (!recordingId) return
  const selectionGeneration = recordingSelectionGeneration
  changeState({ refreshLoading: true, sessionStatus: "Reading the selected Pocket recording…" })
  try {
    const result = await api<{ refreshed: boolean; rawCaptured: boolean; capturedAt?: string; message?: string }>(
      `/recordings/${encodeURIComponent(recordingId)}/refresh`, { method: "POST", body: {} }
    )
    if (!isCurrentRecording(recordingId, selectionGeneration)) return
    const message = result.message ?? `Pocket snapshot saved locally at ${formatDate(result.capturedAt)}. Local Notes revisions were preserved.`
    changeState({ refreshLoading: false, sessionStatus: "Local session active" })
    showNotice(message, !result.refreshed)
    await loadRecordings(true)
    await loadRecording(recordingId)
  } catch (error) {
    if (!isCurrentRecording(recordingId, selectionGeneration)) return
    changeState({ refreshLoading: false, sessionStatus: error instanceof ApiError && error.status === 401 ? "Session expired" : "Local session active" })
    showNotice(sessionFailureMessage(error), true)
  }
}

const openSession = async (code: string): Promise<void> => {
  try {
    await api<{ authenticated: true }>("/session", { method: "POST", body: { code } })
  } catch (error) {
    throw new Error(sessionFailureMessage(error))
  }
}

const startSession = async (): Promise<void> => {
  const code = new URLSearchParams(window.location.hash.slice(1)).get("code")
  if (window.location.hash) window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`)
  try {
    if (code) await openSession(code)
    else await api<{ authenticated: true }>("/session")
    changeState({ authenticated: true, sessionStatus: "Local session active" })
    await loadRecordings(true)
  } catch (error) {
    changeState({ authenticated: false, sessionStatus: "Open the archive from the Pocket CLI" })
    showNotice(sessionFailureMessage(error), true)
  }
}

const searchForm = document.getElementById("search-form") as HTMLFormElement | null
const searchInput = document.getElementById("search-input") as HTMLInputElement | null
searchForm?.addEventListener("submit", (event) => {
  event.preventDefault()
  changeState({ query: searchInput?.value.trim() ?? "" })
  void loadRecordings(true)
})

document.getElementById("load-recordings")?.addEventListener("click", () => { void loadRecordings(false) })
document.getElementById("refresh-button")?.addEventListener("click", () => { void refreshFromPocket() })
document.getElementById("logout-button")?.addEventListener("click", async () => {
  try {
    await api<{ authenticated: false }>("/logout", { method: "POST", body: {} })
    changeState({ authenticated: false, sessionStatus: "Session closed", recordings: [], selectedId: null, detail: null })
  } catch (error) {
    showNotice(sessionFailureMessage(error), true)
  }
})

registry.subscribe(stateAtom, render, { immediate: true })
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) registry.dispose()
})
void startSession()
