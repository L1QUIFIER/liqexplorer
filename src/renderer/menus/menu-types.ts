// Menu framework contract — OWNED BY CORE, do not modify.
// The command bar dropdowns, context menus, and breadcrumb dropdowns all render
// through showMenu() (implemented in menus/menu.ts).

export interface MenuAction {
  id: string
  /** liqicon name or inline SVG string (starts with '<svg') */
  icon?: string
  tooltip: string
  disabled?: boolean
  onClick: () => void
}

export interface MenuItem {
  /** omit for separators */
  label?: string
  /** liqicon name or inline SVG string */
  icon?: string
  /** right-aligned shortcut hint, e.g. 'Ctrl+C' */
  shortcut?: string
  disabled?: boolean
  /** checkbox state; radio renders a bullet */
  checked?: boolean
  radio?: boolean
  /** the default action of a right-drag menu (Explorer renders it bold) */
  bold?: boolean
  danger?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  onClick?: () => void
}

export interface MenuOptions {
  x: number
  y: number
  /** Win11 icon row pinned to the menu (cut/copy/rename/share/delete) */
  iconRow?: MenuAction[]
  /** anchor element: menu aligns below it (command bar dropdowns) */
  anchorEl?: HTMLElement
  minWidth?: number
  onClose?: () => void
}

export type ShowMenu = (items: MenuItem[], opts: MenuOptions) => void
