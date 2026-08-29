/* @gobbonet-split js/25-skills.js
   Skills system: filesystem-first, composable capabilities for cards and global sessions.
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SKILLS & EXTENSIBILITY
   ================================================================ */

let _discoveredSkills = [];
let _selectedSkillName = null;
let _skillHooks = {};
let _skillStores = {};

/**
 * Get the active skills array from state
 */
function getActiveSkillIds() {
  if (!state.activeSkillIds) state.activeSkillIds = [];
  return state.activeSkillIds;
}

/**
 * Check if a skill is currently active
 */
function isSkillActive(name) {
  return getActiveSkillIds().includes(name);
}

/**
 * Fetch all discovered skills from the server
 */
async function fetchSkills() {
  try {
    const resp = await fetch('/skills');
    if (!resp.ok) return [];
    const data = await resp.json();
    _discoveredSkills = (data && Array.isArray(data.skills)) ? data.skills : [];
    updateSkillsBadge();
    applyActiveSkills();
    return _discoveredSkills;
  } catch (e) {
    console.warn('[skills] fetch failed:', e);
    return [];
  }
}

/**
 * Update the skills counter in the sidebar
 */
function updateSkillsBadge() {
  const countEl = document.getElementById('skills-count');
  if (!countEl) return;
  const activeCount = getActiveSkillIds().length;
  countEl.textContent = activeCount > 0 ? '(' + activeCount + ')' : '';
}

/**
 * Apply all active skills: register hooks, styles, and macros
 */
function applyActiveSkills() {
  _skillHooks = {};
  const activeIds = getActiveSkillIds();
  let combinedStyles = '';

  for (const skill of _discoveredSkills) {
    if (!activeIds.includes(skill.name)) continue;

    if (skill.styles) {
      combinedStyles += '\n/* Skill: ' + skill.name + ' */\n' + skill.styles;
    }

    if (skill.code && skill.code.trim()) {
      try {
        const hooks = {};
        const skillApi = {
          skill: skill,
          on(name, fn) {
            if (typeof fn === 'function') {
              (hooks[name] = hooks[name] || []).push(fn);
            }
          },
          store: (_skillStores[skill.name] = _skillStores[skill.name] || {}),
          ask(prompt, opts) {
            if (typeof gobbo !== 'undefined' && gobbo.ask) return gobbo.ask(prompt, opts);
            return Promise.resolve('');
          },
          note(text, opts) {
            if (typeof gobbo !== 'undefined' && gobbo.note) return gobbo.note(text, opts);
            return null;
          },
          notify(msg) {
            if (typeof showModelSwitchToast === 'function') showModelSwitchToast(String(msg));
            else console.log('[skill:' + skill.name + ']', msg);
          },
          log(...args) {
            console.log('[skill:' + skill.name + ']', ...args);
          }
        };

        const fn = new Function('gobbo', 'skill', skill.code);
        fn(skillApi, skill);
        _skillHooks[skill.name] = hooks;
      } catch (e) {
        console.error('[skills] error evaluating code for ' + skill.name + ':', e);
      }
    }
  }

  // Inject or update styles element
  let styleEl = document.getElementById('gobbonet-skill-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'gobbonet-skill-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = combinedStyles;
}

/**
 * Run a hook across all active skills
 */
function runSkillHooks(name, ctx) {
  for (const skillName in _skillHooks) {
    const hooks = _skillHooks[skillName];
    if (hooks && Array.isArray(hooks[name])) {
      for (const fn of hooks[name]) {
        try {
          fn(ctx);
        } catch (e) {
          console.error('[skills] hook error (' + skillName + ':' + name + '):', e);
        }
      }
    }
  }
}

/**
 * Transform text via active skill hooks
 */
function transformViaSkillHook(name, text, ctx) {
  let cur = text;
  for (const skillName in _skillHooks) {
    const hooks = _skillHooks[skillName];
    if (hooks && Array.isArray(hooks[name])) {
      for (const fn of hooks[name]) {
        try {
          const res = fn(Object.assign({}, ctx, { text: cur }));
          if (typeof res === 'string') cur = res;
        } catch (e) {
          console.error('[skills] transform error (' + skillName + ':' + name + '):', e);
        }
      }
    }
  }
  return cur;
}

/**
 * Get aggregated system prompt contributions from all active skills
 */
function getActiveSkillSystemPrompts() {
  const activeIds = getActiveSkillIds();
  const parts = [];
  for (const s of _discoveredSkills) {
    if (activeIds.includes(s.name)) {
      if (s.system_prompt && s.system_prompt.trim()) parts.push(s.system_prompt.trim());
      if (s.personality && s.personality.trim()) parts.push(s.personality.trim());
    }
  }
  return parts.join('\n\n');
}

/**
 * Get aggregated storybook contributions from all active skills
 */
function getActiveSkillStorybooks() {
  const activeIds = getActiveSkillIds();
  const parts = [];
  for (const s of _discoveredSkills) {
    if (activeIds.includes(s.name) && s.storybook && s.storybook.trim()) {
      parts.push(s.storybook.trim());
    }
  }
  return parts.join('\n\n');
}

/**
 * Get aggregated carousel lines from all active skills
 */
function getActiveSkillCarouselLines() {
  const activeIds = getActiveSkillIds();
  const lines = [];
  for (const s of _discoveredSkills) {
    if (activeIds.includes(s.name) && Array.isArray(s.carousel_lines)) {
      lines.push(...s.carousel_lines);
    }
  }
  return lines;
}

/**
 * UI: Open Skills Modal
 */
function openSkillsModal() {
  const modal = document.getElementById('skills-modal');
  if (!modal) return;
  modal.classList.add('open');
  fetchSkills().then(() => {
    renderSkillsList();
    if (_discoveredSkills.length > 0) {
      if (!_selectedSkillName || !_discoveredSkills.find(s => s.name === _selectedSkillName)) {
        _selectedSkillName = _discoveredSkills[0].name;
      }
      selectSkill(_selectedSkillName);
    } else {
      renderEmptySkillDetail();
    }
  });
}

/**
 * UI: Close Skills Modal
 */
function closeSkillsModal() {
  const modal = document.getElementById('skills-modal');
  if (modal) modal.classList.remove('open');
  applyActiveSkills();
  updateSkillsBadge();
}

/**
 * UI: Render Skills List Sidebar in Modal
 */
function renderSkillsList() {
  const listEl = document.getElementById('skills-list');
  if (!listEl) return;

  if (_discoveredSkills.length === 0) {
    listEl.innerHTML = '<div style="color:rgba(255,255,255,0.4);font-size:13px;padding:12px 0;">No skills found on disk. Click "+ NEW SKILL" to create one.</div>';
    return;
  }

  const activeIds = getActiveSkillIds();
  let html = '';

  for (const skill of _discoveredSkills) {
    const isActive = activeIds.includes(skill.name);
    const isSelected = skill.name === _selectedSkillName;

    html += `
      <div style="padding:10px;margin-bottom:8px;border-radius:6px;background:${isSelected ? 'rgba(0,243,255,0.08)' : 'rgba(255,255,255,0.03)'};border:1px solid ${isSelected ? 'var(--neon-blue)' : 'rgba(255,255,255,0.06)'};cursor:pointer;" onclick="selectSkill('${escapeHtml(skill.name)}')">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="font-size:13px;color:${isSelected ? '#00f3ff' : '#fff'};">${escapeHtml(skill.name)}</strong>
          <label style="display:flex;align-items:center;cursor:pointer;margin:0;" onclick="event.stopPropagation();">
            <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleSkillActive('${escapeHtml(skill.name)}', this.checked)" style="cursor:pointer;">
          </label>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escapeHtml(skill.description || 'No description')}
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <span style="font-size:9px;padding:2px 4px;border-radius:3px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);">${escapeHtml((skill.scope || 'global').toUpperCase())}</span>
          ${(skill.tags || []).map(t => `<span style="font-size:9px;padding:2px 4px;border-radius:3px;background:rgba(0,243,255,0.1);color:#00f3ff;">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

/**
 * UI: Select and view/edit a skill
 */
function selectSkill(name) {
  _selectedSkillName = name;
  renderSkillsList();

  const detailEl = document.getElementById('skills-detail');
  if (!detailEl) return;

  const skill = _discoveredSkills.find(s => s.name === name);
  if (!skill) {
    renderEmptySkillDetail();
    return;
  }

  detailEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div>
        <h3 style="margin:0;font-size:16px;color:#00f3ff;">${escapeHtml(skill.name)} <span style="font-size:12px;color:rgba(255,255,255,0.4);font-weight:normal;">v${escapeHtml(skill.version || '1.0.0')}</span></h3>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:2px;">${escapeHtml(skill.description || '')}</div>
      </div>
      <button class="btn btn-sm btn-fill" onclick="saveCurrentSkill()">SAVE TO DISK</button>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
      <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:4px;letter-spacing:1px;font-weight:bold;">SKILL.MD (MARKDOWN SOURCE)</div>
      <textarea id="skill-editor-md" style="flex:1;width:100%;font-family:monospace;font-size:12px;line-height:1.4;background:rgba(0,0,0,0.4);color:#e0f8ff;border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:10px;resize:none;" placeholder="# Skill Markdown...">${escapeHtml(skill.raw_markdown || '')}</textarea>
    </div>
  `;
}

function renderEmptySkillDetail() {
  const detailEl = document.getElementById('skills-detail');
  if (detailEl) {
    detailEl.innerHTML = '<div style="color:rgba(255,255,255,0.3);display:flex;align-items:center;justify-content:center;height:100%;">Select a skill to inspect and edit</div>';
  }
}

/**
 * UI: Toggle skill active status
 */
function toggleSkillActive(name, active) {
  const activeIds = getActiveSkillIds();
  if (active) {
    if (!activeIds.includes(name)) activeIds.push(name);
  } else {
    state.activeSkillIds = activeIds.filter(id => id !== name);
  }
  saveState();
  applyActiveSkills();
  updateSkillsBadge();
  renderSkillsList();
}

/**
 * UI: Save skill changes to server
 */
async function saveCurrentSkill() {
  if (!_selectedSkillName) return;
  const editor = document.getElementById('skill-editor-md');
  if (!editor) return;

  const statusMsg = document.getElementById('skills-status-msg');
  if (statusMsg) statusMsg.textContent = 'Saving ' + _selectedSkillName + '...';

  try {
    const resp = await fetch('/skills/' + encodeURIComponent(_selectedSkillName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_markdown: editor.value })
    });

    if (!resp.ok) {
      if (statusMsg) statusMsg.textContent = 'Error saving skill (HTTP ' + resp.status + ')';
      return;
    }

    if (statusMsg) {
      statusMsg.textContent = 'Saved ' + _selectedSkillName + ' to disk.';
      setTimeout(() => { if (statusMsg) statusMsg.textContent = ''; }, 3000);
    }

    await fetchSkills();
    renderSkillsList();
  } catch (e) {
    console.error('[skills] save failed:', e);
    if (statusMsg) statusMsg.textContent = 'Network error saving skill.';
  }
}

/**
 * UI: Create a new skill template
 */
async function createNewSkill() {
  const name = prompt('Enter a unique name for the new skill (e.g. "code-auditor" or "lore-helper"):');
  if (!name) return;

  const slug = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
  if (!slug) {
    alert('Invalid skill name.');
    return;
  }

  const template = `---
name: ${slug}
version: 1.0.0
description: A custom GobboNet skill.
scope: global
tags: [custom]
---

# ${name}

## System Prompt
[Describe the system prompt instructions this skill adds to character cards]

## Personality
[Optional personality layer]

## Knowledge / RAG Storybook
# ${slug}_knowledge
tags: custom [1.0]
use: Knowledge directives for this skill.

## Card-Code Hooks
\`\`\`javascript
gobbo.on('send', (ctx) => {
  // Executed on user prompt
  return ctx.text;
});
\`\`\`

## Carousel Lines
- Focus on specialized execution for ${name}.
`;

  try {
    const resp = await fetch('/skills/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_markdown: template })
    });

    if (resp.ok) {
      await fetchSkills();
      _selectedSkillName = slug;
      renderSkillsList();
      selectSkill(slug);
    } else {
      alert('Failed to create skill (HTTP ' + resp.status + ')');
    }
  } catch (e) {
    alert('Network error creating skill: ' + e.message);
  }
}
