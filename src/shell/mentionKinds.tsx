/**
 * What the prompt can mention: the tiles on screen, drivers and teams. Each kind searches what it has now,
 * draws its tag (in the DOM for the prompt, and in React for the history and the picker) and says it as
 * text for the agent. A new kind is one more entry here. See src/shell/mentions.ts.
 */
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { rosterOf, type DriverEntry } from '../../shared/sessionData';
import { codeOf, driverCodeElement, DriverCode, fillTitle, host, read, tileTitle, TitleDriver, useLive, type CodeLook } from '../host';
import {
  sayDriver,
  sayTeam,
  sayTile,
  searchDrivers,
  searchTeams,
  searchTiles,
  shortTeamName,
  teamsOf,
  type Mention,
  type MentionOption,
  type PromptPart,
  type TeamEntry,
} from './mentions';

export interface MentionKind {
  name: string;
  /** What a bare `@` heads this kind's rows with. */
  group: string;
  /** The rows for what follows the `@`, best first: none when the kind has nothing to offer now. */
  search(query: string): MentionOption[];
  /** The tag as a DOM element, for the prompt. */
  element(id: string, look: CodeLook): HTMLElement;
  /** Brings a tag in the prompt up to date with what it names, which may have changed since it was drawn. */
  update?(el: HTMLElement, id: string): void;
  /** The tag in React, for the history and the picker. */
  render(id: string, look: CodeLook): ReactNode;
  /** The mention as the agent reads it. */
  say(id: string): string;
  /** The tile on screen the mention is, to outline while it's pointed at. */
  tile?(id: string): string | null;
}

const roster = (): readonly DriverEntry[] => rosterOf(read().sessionData);

const driver: MentionKind = {
  name: 'driver',
  group: 'Drivers',
  search: (query) => searchDrivers(roster(), query),
  element: (id, look) => driverCodeElement(Number(id), look),
  render: (id, look) => <DriverCode number={Number(id)} {...look} />,
  say: (id) => sayDriver(codeOf(Number(id)), Number(id)),
};

// Teams: from the roster, worked out again only when it changes.
let teamCache: { drivers: readonly DriverEntry[]; teams: TeamEntry[] } | null = null;
function teams(drivers: readonly DriverEntry[] = roster()): TeamEntry[] {
  if (teamCache?.drivers !== drivers) teamCache = { drivers, teams: teamsOf(drivers) };
  return teamCache.teams;
}
const teamColour = (team: TeamEntry | undefined): string => {
  const hex = team?.colour?.replace(/^#/, '');
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : 'var(--color-dim)';
};
const teamClass = (look: CodeLook): string => `team-tag ${look.strong ? 'team-tag-strong' : ''}`;

const team: MentionKind = {
  name: 'team',
  group: 'Teams',
  search: (query) => searchTeams(teams(), query, codeOf),
  element(id, look) {
    const el = document.createElement('span');
    el.className = teamClass(look);
    el.style.setProperty('--team', teamColour(teams().find((t) => t.name === id)));
    el.textContent = shortTeamName(id);
    return el;
  },
  render: (id, look) => <TeamTag name={id} look={look} />,
  say: (id) => sayTeam(id, (teams().find((t) => t.name === id)?.drivers ?? []).map((n) => ({ code: codeOf(n), number: n }))),
};

function TeamTag({ name, look }: { name: string; look: CodeLook }) {
  const drivers = useLive((s) => rosterOf(s.sessionData));
  const found = teams(drivers).find((t) => t.name === name);
  return (
    <span className={teamClass(look)} style={{ '--team': teamColour(found) } as CSSProperties}>
      {shortTeamName(name)}
    </span>
  );
}

// Tiles: a tag names a tile by id. Its title is kept from when it was last seen, to draw it once it has closed.
type Title = ReturnType<typeof tileTitle>;
const lastTitle = new Map<string, Title>();

/** A tile's title now, or as it was last seen, and whether it's still on screen. */
function titleOf(id: string): { title: Title; on: boolean } {
  const live = read();
  const tile = live.layout.tiles.find((t) => t.id === id);
  if (!tile) return { title: lastTitle.get(id) ?? { label: id }, on: false };
  const title = tileTitle(tile.component, live.headers[id]);
  lastTitle.set(id, title);
  return { title, on: true };
}

const pointHandlers = (id: string) => ({
  enter: () => void host.layout.point({ tile: id }),
  leave: () => void host.layout.point({ tile: null }),
});

const tile: MentionKind = {
  name: 'tile',
  group: 'On screen',
  search(query) {
    const live = read();
    if (live.session == null) return [];
    return searchTiles(
      live.layout.tiles.map((t) => ({ id: t.id, label: titleOf(t.id).title.label })),
      query,
    );
  },
  element(id) {
    const el = document.createElement('span');
    const { enter, leave } = pointHandlers(id);
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    tile.update!(el, id);
    return el;
  },
  update(el, id) {
    const { title, on } = titleOf(id);
    el.classList.add('tile-tag');
    el.classList.toggle('tile-tag-gone', !on);
    el.dataset.tile = id;
    fillTitle(el, title);
  },
  render: (id) => <TileTag id={id} />,
  say(id) {
    const { title, on } = titleOf(id);
    return sayTile(id, title.label, on);
  },
  tile: (id) => id,
};

function TileTag({ id }: { id: string }) {
  // Drawn again when the tile or its header changes; each code follows the roster itself.
  useLive((s) => s.layout.tiles.find((t) => t.id === id));
  useLive((s) => s.headers[id]);
  const { title, on } = titleOf(id);
  const { enter, leave } = pointHandlers(id);
  return (
    <span className={`tile-tag ${on ? '' : 'tile-tag-gone'}`} data-tile={id} onMouseEnter={enter} onMouseLeave={leave}>
      {title.title ? (
        <>
          {title.title.name ? `${title.title.name} ` : null}
          {title.title.drivers.map((d, i) => (
            <Fragment key={d}>
              {i ? ' · ' : null}
              <TitleDriver driver={d} />
            </Fragment>
          ))}
        </>
      ) : (
        title.label
      )}
    </span>
  );
}

/** Every kind, in the order a bare `@` lists them. */
export const MENTION_KINDS: readonly MentionKind[] = [tile, driver, team];

const kindOf = (name: string): MentionKind | undefined => MENTION_KINDS.find((k) => k.name === name);

/** A tag's look: the code library's bold bar, in the colour of the text around it. */
export const TAG_LOOK: CodeLook = { variant: 'bar', strong: true, tone: 'inherit' };

/** Every kind's rows for a query, best first. Rows that match as well keep the kinds' order. */
export function searchMentions(query: string): MentionOption[] {
  return MENTION_KINDS.flatMap((k) => k.search(query)).sort((a, b) => a.rank - b.rank);
}

/** What a bare `@` heads a kind's rows with. */
export const groupOf = (kind: string): string => kindOf(kind)?.group ?? '';

export const sayMention = (m: Mention): string => kindOf(m.kind)?.say(m.id) ?? '';

export function mentionElement(m: Mention, look: CodeLook = TAG_LOOK): HTMLElement | null {
  return kindOf(m.kind)?.element(m.id, look) ?? null;
}

/** Brings each tag in the prompt up to date, as what they name changes. */
export function updateTags(box: HTMLElement): void {
  for (const el of box.querySelectorAll<HTMLElement>('[data-mention-kind]')) {
    kindOf(el.dataset.mentionKind!)?.update?.(el, el.dataset.mentionId!);
  }
}

/** What a mention draws from, as values that change when it does: the tiles, their headers and the roster. */
export function useMentionSources(): unknown[] {
  return [useLive((s) => s.layout.tiles), useLive((s) => s.headers), useLive((s) => s.sessionData), useLive((s) => s.session)];
}

/** Outlines the tile a mention is, or nothing for a mention that isn't one, or for none. */
export function pointAt(m: Mention | null | undefined): void {
  const tileId = m ? (kindOf(m.kind)?.tile?.(m.id) ?? null) : null;
  host.layout.point({ tile: tileId });
}

export function renderMention(m: Mention, look: CodeLook = TAG_LOOK): ReactNode {
  return kindOf(m.kind)?.render(m.id, look) ?? sayMention(m);
}

/** A prompt in the history: its text, with each mention drawn as its tag. */
export function MentionParts({ parts }: { parts: readonly PromptPart[] }): ReactNode {
  return parts.map((p, i) => (typeof p === 'string' ? p : <Fragment key={i}>{renderMention(p)}</Fragment>));
}
