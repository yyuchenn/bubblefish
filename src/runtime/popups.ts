import { getContext, setContext } from 'svelte';
import { writable } from 'svelte/store';

export type PopupId =
  | 'file'
  | 'edit'
  | 'view'
  | 'more'
  | 'projects'
  | 'zoom'
  | 'canvas-context'
  | 'translation-context';
type CloseReason =
  | 'outside'
  | 'escape'
  | 'action'
  | 'toggle'
  | 'navigation'
  | 'modal'
  | 'interaction'
  | 'target-removed'
  | 'owner-removed'
  | 'blur'
  | 'resize'
  | 'scroll'
  | 'tab'
  | 'destroy';
interface PopupRequest {
  id: PopupId;
  trigger?: HTMLElement | null;
  marker?: { id: string; x: number; y: number };
}
export interface OpenPopup extends PopupRequest {
  token: number;
  projectId: string | null;
  imageId: string | null;
}
interface Boundary {
  id: PopupId;
  token?: number;
}
const popupContext = Symbol('bubblefish.popups');

/** Transient UI state only. Exactly one workspace popup owns the active slot. */
export class PopupController {
  private readonly state = writable<OpenPopup | null>(null);
  readonly subscribe = this.state.subscribe;
  private current: OpenPopup | null = null;
  private sequence = 0;
  private projectId: string | null = null;
  private imageId: string | null = null;
  private readonly boundaries = new Map<HTMLElement, Boundary>();
  private readonly consumed = new Map<number, { surface: HTMLElement; ended: boolean }>();

  get active() {
    return this.current;
  }
  open(request: PopupRequest) {
    const popup: OpenPopup = {
      ...request,
      token: ++this.sequence,
      projectId: this.projectId,
      imageId: this.imageId,
    };
    this.current = popup;
    this.state.set(popup);
  }
  toggle(request: PopupRequest) {
    if (this.current?.id === request.id) this.close('toggle');
    else this.open(request);
  }
  close(reason: CloseReason = 'action', token?: number) {
    const previous = this.current;
    if (!previous || (token !== undefined && previous.token !== token)) return;
    const restore =
      reason === 'escape' &&
      typeof document !== 'undefined' &&
      this.inside(previous, [document.activeElement]);
    this.current = null;
    this.state.set(null);
    if (restore && previous.trigger?.isConnected) previous.trigger.focus({ preventScroll: true });
  }
  setScope(projectId: string | null, imageId: string | null) {
    if (projectId !== this.projectId || imageId !== this.imageId) this.close('navigation');
    this.projectId = projectId;
    this.imageId = imageId;
  }
  /** A surface and its disclosure trigger form one outside-click boundary. */
  boundary = (node: HTMLElement, options: Boundary) => {
    this.boundaries.set(node, options);
    return {
      update: (next: Boundary) => {
        this.boundaries.set(node, next);
      },
      destroy: () => {
        const registered = this.boundaries.get(node);
        this.boundaries.delete(node);
        const active = this.current;
        if (
          active &&
          registered?.id === active.id &&
          (registered.token === undefined || registered.token === active.token)
        ) {
          this.close('owner-removed', active.token);
        }
      },
    };
  };
  private inside(popup: OpenPopup, path: (EventTarget | null)[]) {
    if (
      popup.trigger &&
      path.some(
        (target) =>
          target === popup.trigger || (target instanceof Node && popup.trigger!.contains(target)),
      )
    )
      return true;
    return [...this.boundaries].some(
      ([node, boundary]) =>
        boundary.id === popup.id &&
        (boundary.token === undefined || boundary.token === popup.token) &&
        path.some((target) => target === node || (target instanceof Node && node.contains(target))),
    );
  }
  mount(doc = document, win = window) {
    const elements = (event: Event) =>
      event.composedPath().filter((target): target is HTMLElement => target instanceof HTMLElement);
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const pointerDown = (event: PointerEvent) => {
      for (const [id, record] of this.consumed) if (record.ended) this.consumed.delete(id);
      const path = elements(event);
      const continuing = [...this.consumed.values()].find(
        (record) => !record.ended && path.includes(record.surface),
      );
      if (continuing && event.pointerType === 'touch') {
        this.consumed.set(event.pointerId, { surface: continuing.surface, ended: false });
        block(event);
        return;
      }
      const active = this.current;
      if (!active || this.inside(active, path)) return;
      this.close('outside');
      const canvas = path.find((node) => node.hasAttribute('data-popup-canvas'));
      const control = path.some((node) =>
        node.matches('button,input,textarea,select,a,[role="button"],[data-popup-trigger]'),
      );
      if (canvas && !control && event.button === 0) {
        this.consumed.set(event.pointerId, { surface: canvas, ended: false });
        block(event);
      }
    };
    const pointerUp = (event: PointerEvent) => {
      const record = this.consumed.get(event.pointerId);
      if (record) {
        record.ended = true;
        block(event);
      }
    };
    const pointerCancel = (event: PointerEvent) => {
      if (this.consumed.delete(event.pointerId)) block(event);
    };
    const click = (event: MouseEvent) => {
      if (!event.detail) return;
      const id = 'pointerId' in event ? Number(event.pointerId) : undefined;
      const path = elements(event);
      const match =
        id !== undefined && this.consumed.has(id)
          ? id
          : [...this.consumed].find(
              ([, record]) => record.ended && path.includes(record.surface),
            )?.[0];
      if (match !== undefined) {
        this.consumed.delete(match);
        block(event);
      }
    };
    const contextMenu = (event: MouseEvent) => {
      if (this.current && !this.inside(this.current, elements(event))) this.close('outside');
    };
    const keydown = (event: KeyboardEvent) => {
      if (!this.current || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        this.close('escape');
        block(event);
      } else if (event.key === 'Tab') {
        this.close('tab');
        event.stopImmediatePropagation();
      }
    };
    const blur = () => {
      this.close('blur');
      this.consumed.clear();
    };
    const resize = () => this.close('resize');
    // Observe user scrolling, not scroll events: selecting a canvas marker may
    // programmatically scroll its translation row into view after this opens.
    const wheel = (event: WheelEvent) => {
      if (this.current && !this.inside(this.current, elements(event))) this.close('scroll');
    };
    doc.addEventListener('pointerdown', pointerDown, true);
    doc.addEventListener('pointerup', pointerUp, true);
    doc.addEventListener('pointercancel', pointerCancel, true);
    doc.addEventListener('click', click, true);
    doc.addEventListener('contextmenu', contextMenu, true);
    doc.addEventListener('keydown', keydown, true);
    doc.addEventListener('wheel', wheel, { capture: true, passive: true });
    win.addEventListener('blur', blur);
    win.addEventListener('resize', resize);
    return () => {
      doc.removeEventListener('pointerdown', pointerDown, true);
      doc.removeEventListener('pointerup', pointerUp, true);
      doc.removeEventListener('pointercancel', pointerCancel, true);
      doc.removeEventListener('click', click, true);
      doc.removeEventListener('contextmenu', contextMenu, true);
      doc.removeEventListener('keydown', keydown, true);
      doc.removeEventListener('wheel', wheel, true);
      win.removeEventListener('blur', blur);
      win.removeEventListener('resize', resize);
      this.close('destroy');
      this.consumed.clear();
      this.boundaries.clear();
    };
  }
}

export function providePopups() {
  const popups = new PopupController();
  setContext(popupContext, popups);
  return popups;
}
export function usePopups(): PopupController {
  const popups = getContext<PopupController | undefined>(popupContext);
  if (!popups) throw new Error('PopupController must be provided by the workspace');
  return popups;
}
