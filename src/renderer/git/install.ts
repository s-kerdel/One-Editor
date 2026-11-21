// Git startup stub (startup budget is tight): the slots the lazy git chunk fills in, and the Source
// control panel (lazy) with its icon so its pill is there from the first frame. Marks, the branch item
// and change bars appear once ./index has loaded on idle and the first status is in; until then the
// slots render nothing.
import { signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import type { TreeNode } from '@shared/api';
import type { MenuItem } from '../app/ui';
import type { GitGutterSource } from './gutter';
import { app } from '../app/app';
import { addIcons } from '../app/icons';
import { afterBootIdle, lazyComponent } from '../app/lazy';

export interface GitUi {
  /** Extra classes for a file-tree row. */
  row(path: string, dir: boolean): string;
  Mark: ComponentType<{ path: string; dir: boolean }>;
  /** Status-bar item. */
  Branch: ComponentType;
  /** Above the tree while it shows changed files only. */
  Banner: ComponentType;
  /** "Show changes": the reduced tree with its folders open; null while showing everything. */
  view(tree: TreeNode): { tree: TreeNode; expanded: ReadonlySet<string> } | null;
  /** Tree / tab context-menu items for a file. */
  menu(path: string): MenuItem[];
  /** Tree menu for several selected rows (stage / unstage the files among them). */
  menuMany?(paths: string[]): MenuItem[];
  gutter: GitGutterSource;
}

export const gitUi = signal<GitUi | null>(null);

/** "Select Text for Compare": memory only. Tied to its workspace, so switching folders drops it. */
export interface ComparePick {
  text: string;
  label: string;
  root: string | undefined;
}
export const comparePick = signal<ComparePick | null>(null);

export function installGitLazy() {
  addIcons({ gitBranch: 'M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 9a9 9 0 0 1-9 9' });
  // The pane chunk installs git itself (it imports ./index): one chained import less in the startup code.
  app.registerPanel({ id: 'git', title: 'Git', icon: 'gitBranch', order: 12, component: lazyComponent(() => import('./SourceControl').then((m) => m.SourceControl)) });
  afterBootIdle(() => void import('./index').then((m) => m.installGit()));
}
