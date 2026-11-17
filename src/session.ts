import { AppStateLike, ExcalidrawAPI, ExcalidrawViewLike, PointerPayload } from "./excalidraw";
import { t } from "./i18n";
import type { Snapshot, Transport, TransportEvents, Welcome } from "./net";
import { BinaryFile, Message, PeerInfo, PointerState, SceneElement, SceneView } from "./protocol";

const FLUSH_INTERVAL = 50;
const POINTER_INTERVAL = 40;
const VIEW_INTERVAL = 40;
// Excalidraw's own zoom limits.
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

interface Viewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

export type Role = "host" | "client";
export type JoinMode = "new" | "replace" | "merge";

export interface SessionCallbacks {
	onPeersChanged(): void;
	onPeerJoined(peer: PeerInfo): void;
	onPeerLeft(peer: PeerInfo): void;
	/** `leading` or `leader` changed. */
	onFollowChanged(): void;
	onEnded(reason: string): void;
}

/**
 * Binds one open Excalidraw view to a transport: pushes local element changes
 * out, merges remote ones in, and renders remote cursors.
 *
 * Merging follows Excalidraw's own collab rule: an element with a higher
 * `version` wins, ties go to the lower `versionNonce`. Every peer applies the
 * same rule, so all scenes converge without a central authority.
 *
 * Any peer can move the others to the part of the drawing it shows, once
 * (`shareView`) or on every pan and zoom while `leading` is on. Receivers always
 * apply an incoming view; whoever switches leading on takes it over from the
 * previous leader.
 */
export class LiveSession implements TransportEvents {
	readonly peers = new Map<string, PeerInfo>();
	/** Our pans and zooms are pushed to everyone else. */
	leading = false;
	/** Id of the peer that is leading, if it isn't us. */
	leader: string | null = null;
	transport: Transport | null = null;
	view: ExcalidrawViewLike | null = null;

	/** Last version of each element we sent or received — anything else is a local change. */
	private known = new Map<string, number>();
	private knownFiles = new Set<string>();
	private queue: Message[] = [];
	private collaborators = new Map<string, unknown>();
	private filePath: string | null = null;
	private unhook: (() => void) | null = null;
	private flushTimer: number | null = null;
	private pointerTimer: number | null = null;
	private lastPointerSent = 0;
	private pendingPointer: PointerPayload | null = null;
	/** Last local pointer and the viewport it was measured in, so panning/zooming can move it too. */
	private lastPointer: { payload: PointerPayload; viewport: Viewport } | null = null;
	private collabFrame: number | null = null;
	private viewTimer: number | null = null;
	private lastViewSent = 0;
	private pendingView: SceneView | null = null;
	private lastSentView: SceneView | null = null;
	/** What our canvas shows after applying a remote view, so that change isn't sent back. */
	private appliedView: SceneView | null = null;
	private ended = false;

	constructor(
		readonly role: Role,
		private cb: SessionCallbacks,
	) {}

	get api(): ExcalidrawAPI | null {
		return this.view?.excalidrawAPI ?? null;
	}

	get drawingName(): string {
		return this.view?.file?.basename ?? "";
	}

	/** Starts listening to the view. Hosts call this right away; clients once the welcome arrives. */
	attach(view: ExcalidrawViewLike): void {
		this.view = view;
		this.filePath = view.file?.path ?? null;

		// Shadow the prototype methods with own properties; unhooking restores
		// whatever own property was there before, or removes ours.
		const hooked = ["onChange", "onPointerUpdate"] as const;
		const saved = hooked.map((key) => Object.getOwnPropertyDescriptor(view, key));
		const origChange = view.onChange;
		const origPointer = view.onPointerUpdate;
		view.onChange = (elements, appState, files) => {
			origChange.call(view, elements, appState, files);
			this.scheduleFlush();
			this.onLocalViewport(appState);
		};
		view.onPointerUpdate = (payload) => {
			origPointer.call(view, payload);
			this.onLocalPointer(payload);
		};
		this.unhook = () => {
			hooked.forEach((key, i) => {
				const descriptor = saved[i];
				if (descriptor) Object.defineProperty(view, key, descriptor);
				else Reflect.deleteProperty(view, key);
			});
		};
	}

	/** Host: everything already on the canvas reaches newcomers through the welcome snapshot. */
	markSceneKnown(): void {
		const api = this.requireApi();
		for (const el of api.getSceneElementsIncludingDeleted()) this.known.set(el.id, el.version);
		for (const id of Object.keys(api.getFiles())) this.knownFiles.add(id);
	}

	snapshot(): Snapshot {
		const api = this.requireApi();
		return {
			drawing: this.drawingName,
			elements: [...api.getSceneElementsIncludingDeleted()],
			files: Object.values(api.getFiles()).filter((f) => f?.dataURL),
		};
	}

	/** Client: adopt the host's scene, then replay whatever arrived while we were getting ready. */
	applyWelcome(welcome: Welcome, mode: JoinMode): void {
		const api = this.requireApi();
		for (const peer of welcome.peers) this.peers.set(peer.id, peer);
		this.addFiles(welcome.files);
		if (mode === "merge") {
			this.mergeRemote(welcome.elements);
		} else {
			for (const el of welcome.elements) this.known.set(el.id, el.version);
			api.updateScene({ elements: welcome.elements, captureUpdate: "NEVER", commitToHistory: false });
		}
		// In merge mode our own elements are still unknown to the host; this sends them.
		this.scheduleFlush();
		const queued = this.queue;
		this.queue = [];
		for (const msg of queued) this.onMessage(msg);
		this.cb.onPeersChanged();
	}

	resync(): void {
		if (!this.transport) return;
		if (this.role === "client") {
			this.transport.send({ t: "sync-request" });
		} else {
			const snap = this.snapshot();
			if (snap.files.length) this.transport.send({ t: "files", files: snap.files });
			this.transport.send({ t: "elements", elements: snap.elements });
		}
	}

	end(reason: string): void {
		if (this.ended) return;
		this.ended = true;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		if (this.pointerTimer !== null) window.clearTimeout(this.pointerTimer);
		if (this.viewTimer !== null) window.clearTimeout(this.viewTimer);
		this.leading = false;
		this.leader = null;
		if (this.collabFrame !== null) window.cancelAnimationFrame(this.collabFrame);
		this.unhook?.();
		this.unhook = null;
		const transport = this.transport;
		this.transport = null;
		transport?.close();
		this.collaborators.clear();
		try {
			this.api?.updateScene({ collaborators: new Map() });
		} catch {
			// the view may already be gone
		}
		this.cb.onEnded(reason);
	}

	/** Moves everyone else to the part of the drawing we are looking at. */
	shareView(): void {
		const view = sceneViewOf(this.api?.getAppState());
		if (!this.transport || !view) return;
		this.sendView(view);
	}

	setLeading(on: boolean): void {
		if (this.ended || !this.transport || this.leading === on) return;
		this.leading = on;
		if (on) this.leader = null;
		this.transport.send({ t: "follow", on });
		if (on) this.shareView();
		this.cb.onFollowChanged();
	}

	/** True while the view we're bound to is still showing the same file. */
	isBoundTo(view: ExcalidrawViewLike): boolean {
		return this.view === view && view.file?.path === this.filePath;
	}

	// --- TransportEvents -------------------------------------------------------

	onMessage(msg: Message): void {
		if (this.ended) return;
		if (!this.view) {
			this.queue.push(msg);
			return;
		}
		switch (msg.t) {
			case "elements":
				this.mergeRemote(msg.elements);
				break;
			case "files":
				this.addFiles(msg.files);
				break;
			case "pointer":
				if (msg.from) this.updateCollaborator(msg.from, msg.pointer);
				break;
			case "view":
				this.applyView(msg.view);
				break;
			case "follow":
				if (msg.from) this.onRemoteFollow(msg.from, msg.on);
				break;
		}
	}

	onPeerJoin(peer: PeerInfo): void {
		this.peers.set(peer.id, peer);
		this.cb.onPeerJoined(peer);
		this.cb.onPeersChanged();
		// Pull the newcomer straight into the view we are leading.
		if (this.leading && this.transport) {
			this.transport.send({ t: "follow", on: true });
			this.shareView();
		}
	}

	onPeerLeave(id: string): void {
		const peer = this.peers.get(id);
		this.peers.delete(id);
		if (this.collaborators.delete(id)) this.scheduleCollaborators();
		if (this.leader === id) {
			this.leader = null;
			this.cb.onFollowChanged();
		}
		if (peer) this.cb.onPeerLeft(peer);
		this.cb.onPeersChanged();
	}

	onClosed(reason: string): void {
		this.end(reason);
	}

	// --- outgoing --------------------------------------------------------------

	private scheduleFlush(): void {
		if (this.ended || this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, FLUSH_INTERVAL);
	}

	private flush(): void {
		const api = this.api;
		if (!api || !this.transport || !this.view) return;
		if (this.view.file?.path !== this.filePath) {
			this.end("endOtherDrawing");
			return;
		}

		// Files first, so image elements arriving right after can render immediately.
		const files: BinaryFile[] = [];
		for (const [id, file] of Object.entries(api.getFiles())) {
			if (this.knownFiles.has(id) || !file?.dataURL) continue;
			this.knownFiles.add(id);
			files.push(file);
		}
		if (files.length) this.transport.send({ t: "files", files });

		const changed: SceneElement[] = [];
		for (const el of api.getSceneElementsIncludingDeleted()) {
			if (this.known.get(el.id) === el.version) continue;
			this.known.set(el.id, el.version);
			changed.push(el);
		}
		if (changed.length) this.transport.send({ t: "elements", elements: changed });
	}

	private onLocalPointer(payload: PointerPayload): void {
		if (!this.transport || !payload?.pointer) return;
		const viewport = viewportOf(this.api?.getAppState());
		this.lastPointer = viewport && { payload, viewport };
		this.queuePointer(payload);
	}

	/**
	 * Wheel/pinch zoom and trackpad panning move the canvas under a still mouse
	 * without any pointer event, so the cursor's scene position changes silently.
	 * Re-project the last pointer through the new viewport so peers see it move.
	 */
	private onLocalViewport(appState: AppStateLike | undefined): void {
		this.reprojectPointer(appState);
		if (this.leading) this.queueView(appState);
	}

	private reprojectPointer(appState: AppStateLike | undefined): void {
		const last = this.lastPointer;
		const viewport = viewportOf(appState);
		if (!this.transport || !last || !viewport) return;
		const prev = last.viewport;
		if (viewport.scrollX === prev.scrollX && viewport.scrollY === prev.scrollY && viewport.zoom === prev.zoom) return;
		const { x, y } = last.payload.pointer;
		const payload: PointerPayload = {
			...last.payload,
			pointer: {
				...last.payload.pointer,
				x: ((x + prev.scrollX) * prev.zoom) / viewport.zoom - viewport.scrollX,
				y: ((y + prev.scrollY) * prev.zoom) / viewport.zoom - viewport.scrollY,
			},
		};
		this.lastPointer = { payload, viewport };
		this.queuePointer(payload);
	}

	private queuePointer(payload: PointerPayload): void {
		this.pendingPointer = payload;
		if (this.pointerTimer !== null) return;
		const wait = Math.max(0, POINTER_INTERVAL - (Date.now() - this.lastPointerSent));
		this.pointerTimer = window.setTimeout(() => {
			this.pointerTimer = null;
			this.sendPointer();
		}, wait);
	}

	private sendPointer(): void {
		const p = this.pendingPointer;
		const api = this.api;
		if (!p || !api || !this.transport) return;
		this.pendingPointer = null;
		this.lastPointerSent = Date.now();
		const selected = api.getAppState()?.selectedElementIds ?? {};
		this.transport.send({
			t: "pointer",
			pointer: {
				x: p.pointer.x,
				y: p.pointer.y,
				tool: p.pointer.tool === "laser" ? "laser" : "pointer",
				button: p.button === "down" ? "down" : "up",
				selectedElementIds: Object.keys(selected).filter((id) => selected[id]),
			},
		});
	}

	private queueView(appState: AppStateLike | undefined): void {
		const view = sceneViewOf(appState);
		if (!view || !this.transport) return;
		if (this.lastSentView && sameView(view, this.lastSentView)) return;
		if (this.appliedView && sameView(view, this.appliedView)) return;
		this.pendingView = view;
		if (this.viewTimer !== null) return;
		const wait = Math.max(0, VIEW_INTERVAL - (Date.now() - this.lastViewSent));
		this.viewTimer = window.setTimeout(() => {
			this.viewTimer = null;
			const pending = this.pendingView;
			if (pending && this.leading) this.sendView(pending);
		}, wait);
	}

	private sendView(view: SceneView): void {
		if (!this.transport) return;
		this.pendingView = null;
		this.lastSentView = view;
		this.lastViewSent = Date.now();
		this.transport.send({ t: "view", view });
	}

	// --- incoming --------------------------------------------------------------

	private mergeRemote(remote: SceneElement[]): void {
		const api = this.api;
		if (!api || !remote?.length) return;

		const appState = api.getAppState() ?? {};
		// Never yank an element out from under the local user mid-edit; their
		// next change will carry a higher version and win anyway.
		const busy = new Set<string>(
			[appState.editingTextElement?.id, appState.editingElement?.id, appState.newElement?.id].filter(
				(id): id is string => !!id,
			),
		);

		const local = api.getSceneElementsIncludingDeleted();
		const byId = new Map(local.map((el) => [el.id, el]));
		const added: SceneElement[] = [];
		let changed = false;

		for (const r of remote) {
			if (!r?.id) continue;
			const l = byId.get(r.id);
			if (l && busy.has(r.id)) continue;
			if (l && !remoteWins(l, r)) continue;
			if (!l) added.push(r);
			byId.set(r.id, r);
			this.known.set(r.id, r.version);
			changed = true;
		}
		if (!changed) return;

		let next = [...local.map((el) => byId.get(el.id) as SceneElement), ...added];
		// Excalidraw ≥0.18 orders the scene by fractional `index`; keep that order consistent across peers.
		if (next.every((el) => typeof el.index === "string")) {
			next = next.sort((a, b) =>
				a.index === b.index ? (a.id < b.id ? -1 : 1) : (a.index as string) < (b.index as string) ? -1 : 1,
			);
		}
		api.updateScene({ elements: next, captureUpdate: "NEVER", commitToHistory: false });
	}

	/** Fits the remote view into our canvas: same center, zoomed so all of it is visible. */
	private applyView(remote: SceneView): void {
		const api = this.api;
		const state = api?.getAppState();
		if (!api || !state || !isValidView(remote)) return;
		const { width, height } = state;
		if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return;
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(width / remote.w, height / remote.h)));
		const w = width / zoom;
		const h = height / zoom;
		this.appliedView = { cx: remote.cx, cy: remote.cy, w, h };
		api.updateScene({
			appState: {
				scrollX: w / 2 - remote.cx,
				scrollY: h / 2 - remote.cy,
				zoom: typeof state.zoom === "number" ? zoom : { value: zoom },
			},
			captureUpdate: "NEVER",
		});
	}

	private onRemoteFollow(from: string, on: boolean): void {
		if (on) {
			if (this.leader === from && !this.leading) return;
			this.leader = from;
			this.leading = false;
		} else if (this.leader === from) {
			this.leader = null;
		} else {
			return;
		}
		this.cb.onFollowChanged();
	}

	private addFiles(files: BinaryFile[]): void {
		const api = this.api;
		const fresh = (files ?? []).filter((f) => f?.id && f.dataURL);
		if (!api || !fresh.length) return;
		for (const f of fresh) this.knownFiles.add(f.id);
		api.addFiles(fresh);
	}

	private updateCollaborator(id: string, pointer: PointerState): void {
		const peer = this.peers.get(id);
		if (!peer) return;
		this.collaborators.set(id, {
			id,
			socketId: id,
			username: peer.name,
			color: { background: peer.color, stroke: peer.color },
			pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool },
			button: pointer.button,
			selectedElementIds: Object.fromEntries((pointer.selectedElementIds ?? []).map((e) => [e, true])),
		});
		this.scheduleCollaborators();
	}

	private scheduleCollaborators(): void {
		if (this.collabFrame !== null) return;
		this.collabFrame = window.requestAnimationFrame(() => {
			this.collabFrame = null;
			// Excalidraw only notices a new Map instance.
			this.api?.updateScene({ collaborators: new Map(this.collaborators) });
		});
	}

	private requireApi(): ExcalidrawAPI {
		const api = this.api;
		if (!api) throw new Error(t("noApi"));
		return api;
	}
}

function viewportOf(appState: AppStateLike | undefined): Viewport | null {
	const zoom = typeof appState?.zoom === "number" ? appState.zoom : appState?.zoom?.value;
	const scrollX = appState?.scrollX;
	const scrollY = appState?.scrollY;
	if (!isFiniteNumber(zoom) || !isFiniteNumber(scrollX) || !isFiniteNumber(scrollY) || zoom <= 0) return null;
	return { scrollX, scrollY, zoom };
}

function sceneViewOf(appState: AppStateLike | undefined): SceneView | null {
	const viewport = viewportOf(appState);
	const width = appState?.width;
	const height = appState?.height;
	if (!viewport || !isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return null;
	const w = width / viewport.zoom;
	const h = height / viewport.zoom;
	return { cx: w / 2 - viewport.scrollX, cy: h / 2 - viewport.scrollY, w, h };
}

function isValidView(v: SceneView | undefined): v is SceneView {
	return !!v && isFiniteNumber(v.cx) && isFiniteNumber(v.cy) && isFiniteNumber(v.w) && isFiniteNumber(v.h) && v.w > 0 && v.h > 0;
}

/** Equal up to rounding, which is all a re-measured view differs by. */
function sameView(a: SceneView, b: SceneView): boolean {
	const eps = 1e-6 * Math.max(a.w, a.h, 1);
	return (
		Math.abs(a.cx - b.cx) < eps && Math.abs(a.cy - b.cy) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps
	);
}

function isFiniteNumber(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n);
}

function remoteWins(local: SceneElement, remote: SceneElement): boolean {
	if (remote.version !== local.version) return remote.version > local.version;
	return remote.versionNonce < local.versionNonce;
}
