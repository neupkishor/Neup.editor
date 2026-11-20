import { Clapperboard, Download, FilePlus2, FolderOpen, Redo2, Save, Undo2 } from 'lucide-react';

type EditorHeaderProps = {
  projectName: string;
  saving: 'saved' | 'saving' | 'error';
  canUndo: boolean;
  canRedo: boolean;
  exporting: boolean;
  canExport: boolean;
  onNameChange: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
};

/** Renders the editor brand, project name, history controls, and project actions. */
export default function EditorHeader({ projectName, saving, canUndo, canRedo, exporting, canExport, onNameChange, onUndo, onRedo, onNew, onOpen, onSave, onExport }: EditorHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Clapperboard size={18} /></div><span>neup<span className="brand-light">cut</span></span><span className="beta">EDITOR</span></div>
      <div className="project-name"><input aria-label="Project name" value={projectName} onChange={(event) => onNameChange(event.target.value)} /><span className={`save-indicator ${saving}`} />{saving === 'saved' ? 'Saved to server' : saving === 'saving' ? 'Saving…' : 'Save failed'}</div>
      <div className="top-actions"><button className="top-action history-action" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z / Ctrl+Z)"><Undo2 size={15} /> Undo</button><button className="top-action history-action" onClick={onRedo} disabled={!canRedo} title="Redo (⌘⇧Z / Ctrl+Shift+Z)"><Redo2 size={15} /> Redo</button><button className="top-action" onClick={onNew}><FilePlus2 size={15} /> New</button><button className="top-action" onClick={onOpen}><FolderOpen size={15} /> Open</button><button className="icon-button" aria-label="Save project" title="Save project now" onClick={onSave}><Save size={16} /></button><button className="share-button" onClick={onExport} disabled={exporting || !canExport}><Download size={15} /> {exporting ? 'Exporting…' : 'Export video'}</button></div>
    </header>
  );
}
