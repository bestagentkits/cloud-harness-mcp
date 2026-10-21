import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { DetailList } from '@/components/data/detail-list';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import {
  type AgentkitId, type LicensedKit, NETWORK_PROFILES, type NetworkProfile, type OpenWorkspaceDraft, type PresetToolkit,
  type PresetToolkitId, type SkillConflict, type SkillPreview, type SkillSet
} from './open-workspace-model';

type Patch = (patch: Partial<OpenWorkspaceDraft>) => void;
const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list.filter((value) => value !== item), item] : list.filter((value) => value !== item));

/** Step 1: what to clone and how much network the executor gets. */
export function RepositoryStep({ draft, patch, urlError }: { draft: OpenWorkspaceDraft; patch: Patch; urlError: string | undefined }) {
  return (
    <div className="grid gap-4">
      <Field label="Repository HTTPS URL" description="An approved repository. Private clones authenticate through the harness, never through the URL." error={urlError}>
        <Input autoFocus type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://github.com/org/repo" value={draft.repositoryUrl} onChange={(event) => patch({ repositoryUrl: event.target.value })} />
      </Field>
      <Field label="Branch or commit ref" optional description="The default branch when empty.">
        <Input autoComplete="off" spellCheck={false} placeholder="main" maxLength={255} value={draft.ref} onChange={(event) => patch({ ref: event.target.value })} />
      </Field>
      <Field label="Network profile" description="Dependency access is the shipped default; no network isolates the executor completely.">
        <NativeSelect value={draft.networkProfile} onChange={(event) => patch({ networkProfile: event.target.value as NetworkProfile })}>
          {NETWORK_PROFILES.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
        </NativeSelect>
      </Field>
    </div>
  );
}

/** Step 2: skill sets with their conflict overrides, then owner-scoped toolkits. */
export function AutomationStep({ draft, patch, sets, preview, previewPending, presets, licensed }: {
  draft: OpenWorkspaceDraft;
  patch: Patch;
  sets: SkillSet[];
  preview: SkillPreview | undefined;
  previewPending: boolean;
  presets: PresetToolkit[];
  licensed: LicensedKit[];
}) {
  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Skill sets</legend>
        {sets.length ? (
          <ul className="grid gap-2">
            {sets.map((set) => (
              <CheckRow
                key={set.id}
                label={set.name}
                description={set.description}
                checked={draft.skillSetIds.includes(set.id)}
                disabled={set.generation <= 0}
                onChange={(on) => patch({ skillSetIds: toggle(draft.skillSetIds, set.id, on) })}
              />
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No skill sets yet. <Link to="/skills" className="underline">Manage skills</Link></p>}
      </fieldset>
      {draft.skillSetIds.length ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {previewPending || !preview ? 'Resolving the selected skill sets…' : `${preview.resolved} skill(s) resolved${preview.excluded ? `, ${preview.excluded} excluded` : ''}${preview.conflicts.length ? `, ${preview.conflicts.length} conflict(s) to settle` : ''}.`}
        </p>
      ) : null}
      {preview?.conflicts.length ? <ConflictChoices draft={draft} patch={patch} conflicts={preview.conflicts} /> : null}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Toolkits</legend>
        <p className="text-xs text-muted-foreground">Toolkits install for your identity only and are mounted read-only; nothing is written into the repository.</p>
        <ul className="grid gap-2">
          {presets.map((preset) => (
            <CheckRow
              key={preset.id}
              label={preset.name}
              description={[preset.description, preset.license ? `License: ${preset.license}` : ''].filter(Boolean).join(' ')}
              checked={draft.presets.includes(preset.id)}
              onChange={(on) => patch({ presets: toggle<PresetToolkitId>(draft.presets, preset.id, on) })}
            />
          ))}
          {licensed.map((kit) => (
            <CheckRow
              key={kit.kitId}
              label={kit.name}
              description={kit.ready ? `${kit.description} Channel: ${kit.channel}.` : `${kit.description} Not ready: this instance or your licence token is not set up.`}
              checked={kit.ready && draft.agentkits.includes(kit.kitId)}
              disabled={!kit.ready}
              onChange={(on) => patch({ agentkits: toggle<AgentkitId>(draft.agentkits, kit.kitId, on) })}
            />
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

function CheckRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <li className="flex items-start gap-3 rounded-md border p-3">
      <Checkbox id={id} className="mt-0.5" checked={checked} disabled={disabled} aria-describedby={description ? `${id}-description` : undefined} onCheckedChange={(value) => onChange(value === true)} />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description ? <p id={`${id}-description`} className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
    </li>
  );
}

/** One radio group per conflicting skill name; launch stays blocked until each has a choice. */
function ConflictChoices({ draft, patch, conflicts }: { draft: OpenWorkspaceDraft; patch: Patch; conflicts: SkillConflict[] }) {
  return (
    <div className="grid gap-3" role="group" aria-label="Skill conflicts">
      <p className="text-sm">The selected sets pin different revisions of the same skill. Choose one revision for each before launching.</p>
      {conflicts.map((conflict) => (
        <fieldset key={conflict.name} className="grid gap-1.5 rounded-md border p-3">
          <legend className="px-1 font-mono text-sm">{conflict.name}</legend>
          {conflict.candidates.map((candidate) => (
            <label key={candidate.revisionId} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`conflict-${conflict.name}`}
                value={candidate.revisionId}
                checked={draft.skillOverrides[conflict.name] === candidate.revisionId}
                onChange={() => patch({ skillOverrides: { ...draft.skillOverrides, [conflict.name]: candidate.revisionId } })}
              />
              <span>{candidate.tier} · <span className="font-mono text-xs">{candidate.revisionId}</span></span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

/** Step 3: what the launch will send, in the operator's words. */
export function ReviewStep({ draft, sets, presets, licensed, preview, toolkitCheck }: {
  draft: OpenWorkspaceDraft;
  sets: SkillSet[];
  presets: PresetToolkit[];
  licensed: LicensedKit[];
  preview: SkillPreview | undefined;
  toolkitCheck: string;
}) {
  const setNames = draft.skillSetIds.map((id) => sets.find((set) => set.id === id)?.name ?? id);
  const toolkitNames = [
    ...draft.presets.map((id) => presets.find((preset) => preset.id === id)?.name ?? id),
    ...draft.agentkits.filter((id) => licensed.some((kit) => kit.kitId === id && kit.ready)).map((id) => licensed.find((kit) => kit.kitId === id)?.name ?? id)
  ];
  return (
    <div className="grid gap-3">
      <DetailList items={[
        { label: 'Repository', value: draft.repositoryUrl.trim(), mono: true },
        { label: 'Ref', value: draft.ref.trim() || 'Default branch', mono: Boolean(draft.ref.trim()) },
        { label: 'Network', value: NETWORK_PROFILES.find((profile) => profile.value === draft.networkProfile)?.label ?? draft.networkProfile },
        { label: 'Skill sets', value: setNames.length ? setNames.join(', ') : 'None' },
        { label: 'Resolved skills', value: preview ? String(preview.resolved) : draft.skillSetIds.length ? 'Not resolved yet' : 'None' },
        { label: 'Toolkits', value: toolkitNames.length ? toolkitNames.join(', ') : 'None' }
      ]} />
      {toolkitCheck ? <p className="text-xs text-muted-foreground" aria-live="polite">{toolkitCheck}</p> : null}
      <p className="text-xs text-muted-foreground">The workspace is TTL-limited and has a fixed hard deadline that no renewal extends.</p>
    </div>
  );
}
