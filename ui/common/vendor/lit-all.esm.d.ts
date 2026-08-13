/**
 * Type declarations for the vendored Lit bundle.
 *
 * Two jobs. First, TypeScript prefers a sibling `.d.ts` over the `.js`, so this
 * stops `tsc --checkJs` from type-checking 28KB of minified third-party output —
 * which reported ~75 meaningless errors and would have made the whole type-check
 * gate useless. Second, it gives us real types for Lit with no `node_modules` at
 * runtime.
 *
 * This file is OURS. `lit-all.esm.js` is replaced wholesale on upgrade (see
 * vendor/README.md), so a `@ts-nocheck` inside it would be lost; declarations
 * here survive. Add to it when you start using another Lit export.
 */

export interface TemplateResult {
  readonly _$litType$: unknown;
}

export const nothing: unique symbol;
export const noChange: unique symbol;

export function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult;
export function svg(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult;
export function css(strings: TemplateStringsArray, ...values: unknown[]): CSSStyleSheet;
export function render(value: unknown, container: HTMLElement | DocumentFragment, options?: object): unknown;

export interface PropertyDeclaration {
  type?: unknown;
  attribute?: boolean | string;
  reflect?: boolean;
  state?: boolean;
  converter?: unknown;
  hasChanged?: (value: unknown, old: unknown) => boolean;
}

export class ReactiveElement extends HTMLElement {
  static properties: Record<string, PropertyDeclaration>;
  static styles: unknown;
  requestUpdate(name?: string, oldValue?: unknown, options?: PropertyDeclaration): void;
  readonly updateComplete: Promise<boolean>;
  connectedCallback(): void;
  disconnectedCallback(): void;
  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void;
}

export class LitElement extends ReactiveElement {
  /** Returning `this` opts out of Shadow DOM — the house rule here. */
  protected createRenderRoot(): HTMLElement | ShadowRoot;
  protected render(): unknown;
  protected firstUpdated(changed: Map<string, unknown>): void;
  protected updated(changed: Map<string, unknown>): void;
  protected willUpdate(changed: Map<string, unknown>): void;
}

// Directives — declared loosely; they are only ever used inside html`` holes.
export function unsafeHTML(value: string): unknown;
export function classMap(classInfo: Record<string, boolean>): unknown;
export function styleMap(styleInfo: Record<string, string | number>): unknown;
export function repeat<T>(items: Iterable<T>, keyFn: (item: T, index: number) => unknown, template?: (item: T, index: number) => unknown): unknown;
export function when<T>(condition: boolean, trueCase: () => T, falseCase?: () => T): T;
export function map<T>(items: Iterable<T> | undefined, f: (item: T, index: number) => unknown): unknown;
export function join(items: Iterable<unknown> | undefined, joiner: unknown): unknown;
export function ifDefined(value: unknown): unknown;
export function live(value: unknown): unknown;
export function ref(refOrCallback: unknown): unknown;
export function createRef<T = Element>(): { value?: T };
export function cache(value: unknown): unknown;
export function guard(dependencies: unknown, valueFn: () => unknown): unknown;
export function keyed(key: unknown, value: unknown): unknown;
export function asyncReplace(value: AsyncIterable<unknown>, mapper?: (v: unknown, i: number) => unknown): unknown;
export function until(...values: unknown[]): unknown;

// @lit/context — available for per-subtree dependency overrides later.
export function createContext<T>(key: unknown): { __context__: T };
export class ContextProvider<T> {
  constructor(host: HTMLElement, options: { context: { __context__: T }; initialValue?: T });
  setValue(value: T): void;
}
export class ContextConsumer<T> {
  constructor(host: HTMLElement, options: { context: { __context__: T }; callback?: (value: T) => void; subscribe?: boolean });
  get value(): T | undefined;
}
export class ContextRoot {
  attach(element: HTMLElement): void;
}
