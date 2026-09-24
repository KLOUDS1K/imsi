import './theme/tokens.css';
import { mountKloudEditor } from './app';

const root = document.getElementById('app');
if (root) void mountKloudEditor(root);
