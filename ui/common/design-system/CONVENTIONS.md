# Design-system component conventions

The rules every element under `common/design-system/` follows. `gen-catalog.mjs`
enforces the mechanical ones (JSDoc ↔ code drift, closed enums for appearance
attributes, no styling attributes); the rest are reviewed against this file.
Where a rule is new, the old form still works for one release through a
deprecated alias (`utils/deprecate.js`) and logs the new form once.

## 1. Naming

- **Element:** `app-<noun>`, kebab-case, one noun (`app-menu`, not `app-action-menu`;
  `app-combobox`, not `auto-complete`). Sub-elements are `app-<noun>-<part>`
  (`app-list-item`).
- **Attributes:** kebab-case, boolean attributes are bare and positive. A negated
  behaviour is `no-<thing>` (`no-outside-dismiss`, `no-reset`); never `hide-`,
  `disable-`, `without-`.
- **Never use a global HTML attribute for component data.** `title` shows a native
  tooltip, `id`, `hidden`, `lang`, `dir`, `slot`, `style`, `class` all mean
  something to the browser. Headings are `heading`; secondary text is `description`.
- **CSS classes** inside a component are plain (`.row`, `.label`, `.is-selected`),
  scoped by the sheet's `@scope (app-x)`; state classes are `is-*`.

## 2. Shared vocabulary

| Attribute | Meaning | Values |
| :-- | :-- | :-- |
| `variant` | Visual tone / style | closed set, documented as `` `a` | `b` `` |
| `size` | Control size | `sm` `md` `lg` (+ `xs`/`xl`/`2xl` where the design has them). `md` is the default |
| `orientation` | Layout axis | `horizontal` (default) `vertical` |
| `selection` | How many children may be selected | `single` `multiple` `none` |
| `side` / `align` | Overlay placement | `top bottom left right` / `start center end` |
| `state` | Render a pseudo-state statically (design-system page, parity tests) | `hover` `focus` `error` `success` … |
| `heading` | The element's title text | free string |
| `description` | Secondary text under the heading | free string |
| `label` | The accessible / visible name of a *control* or region | free string |
| `hint` | Helper line under a form control | free string |
| `value` | The control's current value; **reflected** as the user changes it | |
| `disabled` `readonly` `required` `loading` `open` `selected` `checked` `pressed` | Standard booleans | |
| `name` | Forwarded to the native control for form submit | |
| `items` / `options` / `groups` | JSON data for list-like components | JSON array |

`type` is reserved for the native meaning (`<input type>`, `<button type>`).

## 3. Slots

Light DOM only. A named child position is marked with **`data-slot="<name>"`**,
never `slot=` (that is a Shadow DOM attribute and does nothing here). Common
names: `leading`, `trailing`, `icon`, `action`, `actions`, `footer`, `meta`,
`content`. The default slot is "everything else". Document each with
`@slot [data-slot="name"]`.

## 4. Events

Native first. A component wrapping a native control lets the native event
bubble — `change`, `input`, `close` — with `detail` added where the native
event has none (`change` from `app-calendar` carries `{ value }`).

Everything else is a `CustomEvent` named **`<element>-<verb>`**, where
`<element>` is the tag without `app-` and `<verb>` is present tense:

| Element | Events |
| :-- | :-- |
| menu, context-menu | `menu-select { id }`, `menu-toggle { open }` |
| popover / hover-card / sheet / modal / command | `<x>-toggle { open }`; sheet/modal also `<x>-close { result }` |
| tag | `tag-change { selected }`, `tag-remove` (cancelable) |
| toggle / toggle-group / tag-group | `toggle-change`, `toggle-group-change { value }`, `tag-group-change { value }` |
| list / list-item | `list-select { id, index }`, `list-item-select`, `list-item-toggle` |
| breadcrumb | `breadcrumb-select { id, label, index }` |
| pagination | `pagination-change { page }` |
| resizable | `resizable-change { sizes }` |
| tabs | `tabs-change { key }` |
| combobox | `combobox-select { value, option }` |
| alert / banner | `alert-dismiss`, `banner-close` (both cancelable) |

Every event **bubbles**. A component never mutates a parent-owned selection: it
emits, the owner sets the attribute (controlled components — the same rule as
Flutter's `value` + `onChanged`).

## 5. Methods and properties

- Overlays expose **`show()` / `hide()`**, and `open` as the reflected
  attribute + property. Never define a method with the same name as a reflected
  attribute — a method silently replaces the getter.
- Dismissable dialogs additionally take `hide(result)`; `<x>-close` carries it.
- Value controls expose a `value` property and, where there is one, the inner
  native control as `.input` / `.select`.

## 6. Accessibility

- The **inner native control** carries the accessible name (`aria-label` is
  forwarded to it, or `label` renders a real `<label for>`); the host is not
  focusable.
- Roving focus for composite widgets (list, toggle-group, tag-group, menu,
  calendar): one tab stop, arrows move, Home/End jump, wrap-around.
- Overlays return focus to their trigger on Escape and on selection.
- Motion honours `prefers-reduced-motion`.

## 7. Implementation shape

- Light DOM, `@scope (app-x)` sheet loaded with `loadCss()`, tokens only.
- Every `innerHTML` interpolation goes through `escHtml` / `escAttr`; a bound
  JSON attribute is parsed leniently (bad JSON → empty, `console.warn`).
- **Slot capture happens in `render()`**, not `connectedCallback`: during
  upgrade `attributeChangedCallback` runs first with `isConnected === true`.
- Document / window listeners are removed in `disconnectedCallback`.
- Anchored overlays use `utils/anchor.js` and a top-layer `popover="manual"`
  surface **inside the host**.
- A Flutter-ported component records its source (`NasikoX`) in the header.

## 8. Weave / DSL

- Every element has an entry in `surface/dsl-overrides.json`: `ready`, or
  `blocked` with a reason. `blocked` is for page chrome (loading bar, command
  palette) — not for components that are merely awkward.
- Data comes in through a `data-fn` attribute naming a registered source
  (`core/data-sources.js`), never a `window.*` global.
- An `actionParam` component names its Action's event with `actionEvent` and
  has an attribute the accessible name can come from (`label` / `aria-label`).
- Appearance attributes are closed enums; raw CSS lengths are withheld from the
  catalog; a markup sink is marked `(markup)`.
- A deprecated alias attribute is marked `(deprecated: use x)` — observed for
  reactivity, withheld from the catalog.
