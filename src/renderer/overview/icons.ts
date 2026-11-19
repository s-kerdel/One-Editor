// Icons only the overview panel uses: registered with the shell's <Icon> when this chunk loads,
// so their path data stays out of the startup bundle.
import { addIcons } from '../app/icons';

addIcons({
  'ov-tasks': 'M9 11l3 3L22 4|M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  'ov-out': 'M7 17 17 7|M8 7h9v9',
  'ov-back': 'M9 14 4 9l5-5|M20 20v-7a4 4 0 0 0-4-4H4',
  'ov-fold': 'm7 20 5-5 5 5|m7 4 5 5 5-5',
  'ov-unfold': 'm7 15 5 5 5-5|m7 9 5-5 5 5',
});
