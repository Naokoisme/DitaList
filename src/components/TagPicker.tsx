import { useId, useState } from "react";
import { Check, Hash, Plus, Search } from "lucide-react";
import type { TagInfo } from "../generated/contracts";
import { tagPath } from "../core/tags";

export default function TagPicker({index, selected, value, onChange, onAdd}: {
  index: readonly TagInfo[]; selected: readonly string[]; value: string;
  onChange: (value: string) => void; onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const query = value.trim().replace(/^#+/, "");
  const options = index.filter((tag) => tagPath(index, tag.id).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const exact = index.find((tag) => tag.id === query || tag.path.join(" › ") === query);
  const matchingNames = index.filter((tag) => tag.name === query);
  const add = (id: string) => { if (!selected.includes(id)) onAdd(id); onChange(""); setOpen(false); };
  return <div className="tag-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!query) return; if (exact) add(exact.id); else if (matchingNames.length === 1) add(matchingNames[0].id); else if (!matchingNames.length) add(query); else setOpen(true); }}>
      <Search size={13}/>
      <input aria-label="添加标签" placeholder="搜索或添加标签" value={value} maxLength={200}
        aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        onFocus={() => setOpen(true)} onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } }}/>
    </form>
    {open && <div className="tag-picker-options" id={listId} role="listbox" aria-label="选择任务标签">
      {options.map((tag) => <button type="button" role="option" aria-selected={selected.includes(tag.id)} key={tag.id}
        className="tag-picker-option" style={{paddingLeft: `${10 + (tag.path.length - 1) * 14}px`}}
        onMouseDown={(event) => event.preventDefault()} onClick={() => add(tag.id)} title={tagPath(index, tag.id)}>
        <Hash size={13}/><span><strong>{tag.name}</strong>{tag.parentId && <small>{tag.path.slice(0, -1).join(" › ")}</small>}</span>
        {selected.includes(tag.id) && <Check size={13}/>}
      </button>)}
      {query && !exact && <button type="button" className="tag-picker-create" onMouseDown={(event) => event.preventDefault()} onClick={() => add(query)}><Plus size={13}/>添加一级标签“{query}”</button>}
      {!options.length && !query && <p>先从侧栏创建标签，也可直接输入一级标签。</p>}
    </div>}
  </div>;
}
