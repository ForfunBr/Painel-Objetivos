(function() {
  const CATEGORIES = [
    { key: 'gerais', label: 'Objetivos Gerais', color: '#8b7cf6' },
    { key: 'proximos', label: 'Objetivos Próximos', color: '#4fc3d9' },
    { key: 'medio_longo', label: 'Objetivos a Médio e Longo Prazo', color: '#e0607a' },
  ];
  const PRIORITIES = [
    { key: 'urgente', label: 'Urgente' },
    { key: 'programe', label: 'Se programe' },
    { key: 'delegue', label: 'Delegue' },
    { key: 'livre', label: 'Tempo livre' },
  ];
  const PRIORITY_ORDER = { urgente: 0, programe: 1, delegue: 2, livre: 3 };
  const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const CHART_COLORS = { urgente: 'var(--danger)', programe: 'var(--yellow)', delegue: 'var(--blue)', livre: 'var(--green)', sem: '#5b6169' };

  const INITIAL_SCORE = 1000;
  const PRIORITY_POINTS = { urgente: 100, programe: 50, delegue: 25, livre: 10, sem: 0 };
  let score = INITIAL_SCORE;
  let scoreHistory = []; // { id, timestamp, delta, reason, balance }

  function pointsFor(priority) {
    return PRIORITY_POINTS[priority] !== undefined ? PRIORITY_POINTS[priority] : PRIORITY_POINTS.sem;
  }

  function applyScoreDelta(delta, reason) {
    if (delta === 0) return;
    score += delta;
    scoreHistory.push({ id: uid(), timestamp: Date.now(), delta, reason, balance: score });
    if (scoreHistory.length > 500) scoreHistory = scoreHistory.slice(-500);
  }
  const STORAGE_KEY = 'objectives-data-v1';
  let objectives = [];
  let ready = false;
  let proximosSort = 'none'; // 'none' | 'date' | 'priority'
  let selectedChartYear = 'all'; // 'all' or a specific year number
  let editingId = null; // id of objective currently being edited, or null

  function uid() { return 'o_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR');
  }

  function dueBadgeClass(iso, done) {
    if (done) return '';
    const due = new Date(iso + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / 86400000);
    if (diffDays < 0) return ' overdue';
    if (diffDays <= 3) return ' soon';
    return '';
  }

  async function load() {
    let hasStoredData = false;
    try {
      const res = await window.storage.get(STORAGE_KEY, false);
      const parsed = res && res.value ? JSON.parse(res.value) : null;
      if (parsed && Array.isArray(parsed)) {
        // backward-compatible: old format was a plain array of objectives
        objectives = parsed;
        score = INITIAL_SCORE;
        scoreHistory = [];
        hasStoredData = true;
      } else if (parsed) {
        objectives = parsed.objectives || [];
        score = typeof parsed.score === 'number' ? parsed.score : INITIAL_SCORE;
        scoreHistory = Array.isArray(parsed.history) ? parsed.history : [];
        hasStoredData = true;
      } else {
        objectives = [];
        score = INITIAL_SCORE;
        scoreHistory = [];
      }
    } catch (e) {
      objectives = [];
      score = INITIAL_SCORE;
      scoreHistory = [];
    }

    if (!hasStoredData) {
      await tryAutoLoadFromRepo();
    }

    ready = true;
    document.getElementById('subtitleText').textContent = 'carregue ou salve sua planilha Excel para manter os dados';
    applyAutoPenalties();
    render();
  }

  async function save() {
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify({ objectives, score, history: scoreHistory }), false);
    } catch (e) {
      console.error('Falha ao salvar', e);
    }
  }

  function addObjective(catKey, text, dueDate, priority, description) {
    if (!text.trim()) return;
    objectives.push({ id: uid(), category: catKey, text: text.trim(), description: (description || '').trim(), done: false, createdAt: Date.now(), dueDate: dueDate || null, priority: priority || '', failed: false, autoPenalized: false });
    save();
    render();
  }

  function toggleObjective(id) {
    const o = objectives.find(x => x.id === id);
    if (!o) return;

    if (!o.done) {
      // marking as done
      if (o.failed) {
        // reverse the failed penalty first, since it can't be both done and failed
        applyScoreDelta(pointsFor(o.priority), 'Reversão de "não cumprido": ' + o.text);
        o.failed = false;
      }
      o.done = true;
      o.completedAt = Date.now();
      applyScoreDelta(pointsFor(o.priority), 'Concluído: ' + o.text);
    } else {
      // un-marking (was done, now undone) — reverse the reward
      o.done = false;
      o.completedAt = null;
      applyScoreDelta(-pointsFor(o.priority), 'Conclusão desfeita: ' + o.text);
    }
    save();
    render();
  }

  function toggleFailed(id) {
    const o = objectives.find(x => x.id === id);
    if (!o) return;

    if (o.failed) {
      // undo manual failure mark
      applyScoreDelta(pointsFor(o.priority), 'Reversão de "não cumprido": ' + o.text);
      o.failed = false;
    } else {
      // if it was marked done, reverse that reward first
      if (o.done) {
        applyScoreDelta(-pointsFor(o.priority), 'Conclusão desfeita: ' + o.text);
        o.done = false;
        o.completedAt = null;
      }
      applyScoreDelta(-pointsFor(o.priority), 'Não cumprido: ' + o.text);
      o.failed = true;
    }
    save();
    render();
  }

  function applyAutoPenalties() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let changed = false;

    objectives.forEach(o => {
      if (!o.done && !o.failed && !o.autoPenalized && o.dueDate) {
        const due = new Date(o.dueDate + 'T00:00:00');
        if (due < today) {
          applyScoreDelta(-pointsFor(o.priority), 'Prazo vencido: ' + o.text);
          o.autoPenalized = true;
          changed = true;
        }
      }
    });

    if (changed) save();
  }

  function deleteObjective(id) {
    objectives = objectives.filter(x => x.id !== id);
    save();
    render();
  }

  function checkSvg() {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#0e1210" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function saveEditedObjective(id, newText, newPriority, newDueDate, newDescription) {
    const o = objectives.find(x => x.id === id);
    if (o && newText.trim()) {
      const oldPriority = o.priority;
      const nextPriority = newPriority || '';
      const nextDueDate = newDueDate || null;
      const label = newText.trim();

      if (nextPriority !== oldPriority) {
        if (o.done) {
          const delta = pointsFor(nextPriority) - pointsFor(oldPriority);
          applyScoreDelta(delta, 'Ajuste de prioridade (concluído): ' + label);
        } else if (o.failed) {
          const delta = pointsFor(oldPriority) - pointsFor(nextPriority);
          applyScoreDelta(delta, 'Ajuste de prioridade (não cumprido): ' + label);
        }
      }

      if (o.autoPenalized) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const stillOverdue = nextDueDate && new Date(nextDueDate + 'T00:00:00') < today;
        if (!stillOverdue) {
          applyScoreDelta(pointsFor(oldPriority), 'Penalidade de prazo revertida: ' + label);
          o.autoPenalized = false;
        }
      }

      o.text = label;
      o.description = (newDescription || '').trim();
      o.priority = nextPriority;
      o.dueDate = nextDueDate;
      save();
    }
    editingId = null;
    render();
  }

  function cancelEdit() {
    editingId = null;
    render();
  }

  function buildEditRow(o, cat) {
    const row = document.createElement('div');
    row.className = 'edit-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = o.text;
    input.placeholder = 'Título do objetivo';

    const descInput = document.createElement('textarea');
    descInput.rows = 2;
    descInput.placeholder = 'Descrição (opcional)...';
    descInput.value = o.description || '';

    const prioritySelect = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Sem prioridade';
    prioritySelect.appendChild(noneOpt);
    PRIORITIES.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      if (o.priority === p.key) opt.selected = true;
      prioritySelect.appendChild(opt);
    });

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = o.dueDate || '';
    dateInput.title = 'Prazo de conclusão';

    const doSave = () => saveEditedObjective(o.id, input.value, prioritySelect.value, dateInput ? dateInput.value : null, descInput.value);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') cancelEdit();
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-row-btn save';
    saveBtn.textContent = 'Salvar';
    saveBtn.onclick = doSave;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-row-btn cancel';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.onclick = cancelEdit;

    row.appendChild(input);
    if (dateInput) row.appendChild(dateInput);
    row.appendChild(prioritySelect);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    row.appendChild(descInput);
    return row;
  }

  function partitionDoneLast(items) {
    const open = items.filter(o => !o.done);
    const done = items.filter(o => o.done);
    return open.concat(done);
  }

  function sortItems(items, catKey) {
    if (catKey !== 'proximos' || proximosSort === 'none') return items;
    const copy = items.slice();
    if (proximosSort === 'date') {
      copy.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return a.createdAt - b.createdAt;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      });
    } else if (proximosSort === 'priority') {
      copy.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.createdAt - b.createdAt;
      });
    }
    return copy;
  }

  let expandedDone = new Set();
  let openMenuId = null;
  let descOpenId = null;

  function toggleRowMenu(id) {
    openMenuId = (openMenuId === id) ? null : id;
    render();
  }

  function toggleDesc(id) {
    descOpenId = (descOpenId === id) ? null : id;
    render();
  }

  function toggleDoneSection(catKey) {
    if (expandedDone.has(catKey)) expandedDone.delete(catKey);
    else expandedDone.add(catKey);
    render();
  }

  function buildItemRow(o, cat) {
    const row = document.createElement('div');
    row.className = 'item-row';

    const box = document.createElement('div');
    box.className = 'checkbox' + (o.done ? ' checked' : '');
    box.innerHTML = checkSvg();
    box.onclick = () => toggleObjective(o.id);

    const txt = document.createElement('div');
    txt.className = 'item-text' + (o.done ? ' done' : '') + (o.description ? ' has-desc' : '');
    txt.textContent = o.text;

    if (o.description) {
      txt.classList.add('desc-trigger');
      txt.onclick = (e) => { e.stopPropagation(); toggleDesc(o.id); };

      const popover = document.createElement('div');
      popover.className = 'item-desc-popover' + (descOpenId === o.id ? ' open' : '');
      popover.textContent = o.description;
      popover.onclick = (e) => e.stopPropagation();
      txt.appendChild(popover);
    }

    row.appendChild(box);
    row.appendChild(txt);

    const meta = document.createElement('div');
    meta.className = 'item-meta';

    if (o.priority) {
      const pcfg = PRIORITIES.find(p => p.key === o.priority);
      if (pcfg) {
        const pbadge = document.createElement('div');
        pbadge.className = 'priority-badge ' + pcfg.key;
        pbadge.textContent = pcfg.label;
        meta.appendChild(pbadge);
      }
    }

    if (o.dueDate) {
      const badge = document.createElement('div');
      badge.className = 'due-badge' + dueBadgeClass(o.dueDate, o.done);
      badge.textContent = '📅 ' + formatDate(o.dueDate);
      meta.appendChild(badge);
    }

    if (o.failed) {
      const fbadge = document.createElement('div');
      fbadge.className = 'failed-badge';
      fbadge.textContent = '⚠ Não cumprido';
      meta.appendChild(fbadge);
    } else if (o.autoPenalized) {
      const pbadge2 = document.createElement('div');
      pbadge2.className = 'penalty-tag';
      pbadge2.textContent = '−' + pointsFor(o.priority) + ' (prazo vencido)';
      meta.appendChild(pbadge2);
    }

    row.appendChild(meta);

    const menu = document.createElement('div');
    menu.className = 'row-menu';

    const menuBtn = document.createElement('div');
    menuBtn.className = 'row-menu-btn' + (openMenuId === o.id ? ' active' : '');
    menuBtn.textContent = '⋮';
    menuBtn.onclick = (e) => { e.stopPropagation(); toggleRowMenu(o.id); };
    menu.appendChild(menuBtn);

    if (openMenuId === o.id) {
      const dropdown = document.createElement('div');
      dropdown.className = 'row-menu-dropdown';

      const editItem = document.createElement('div');
      editItem.className = 'row-menu-item';
      editItem.innerHTML = '✎ Editar';
      editItem.onclick = (e) => { e.stopPropagation(); openMenuId = null; editingId = o.id; render(); };
      dropdown.appendChild(editItem);

      const failItem = document.createElement('div');
      failItem.className = 'row-menu-item' + (o.failed ? ' active-state' : '');
      failItem.innerHTML = o.failed ? '⚠ Desmarcar não cumprido' : '⚠ Marcar como não cumprido';
      failItem.onclick = (e) => { e.stopPropagation(); openMenuId = null; toggleFailed(o.id); };
      dropdown.appendChild(failItem);

      const delItem = document.createElement('div');
      delItem.className = 'row-menu-item danger';
      delItem.innerHTML = '✕ Apagar objetivo';
      delItem.onclick = (e) => { e.stopPropagation(); openMenuId = null; deleteObjective(o.id); };
      dropdown.appendChild(delItem);

      menu.appendChild(dropdown);
    }

    row.appendChild(menu);
    return row;
  }

  function renderSections() {
    const host = document.getElementById('sectionsHost');
    host.innerHTML = '';
    CATEGORIES.forEach(cat => {
      const rawItems = objectives.filter(o => o.category === cat.key);
      const sorted = sortItems(rawItems, cat.key);
      const openItems = sorted.filter(o => !o.done);
      const doneItems = sorted.filter(o => o.done);
      const totalCount = sorted.length;
      const doneCount = doneItems.length;

      const section = document.createElement('div');
      section.className = 'section';

      const head = document.createElement('div');
      head.className = 'section-head';
      head.innerHTML =
        '<div class="section-title"><span class="dot" style="background:' + cat.color + '"></span>' + cat.label + '</div>';
      const headRight = document.createElement('div');
      headRight.style.display = 'flex';
      headRight.style.alignItems = 'center';
      headRight.style.gap = '10px';

      if (cat.key === 'proximos') {
        const sortToggle = document.createElement('div');
        sortToggle.className = 'sort-toggle';
        const opts = [
          { key: 'none', label: 'Padrão' },
          { key: 'date', label: 'Data' },
          { key: 'priority', label: 'Prioridade' },
        ];
        opts.forEach(opt => {
          const el = document.createElement('div');
          el.className = 'sort-opt' + (proximosSort === opt.key ? ' active' : '');
          el.textContent = opt.label;
          el.onclick = () => { proximosSort = opt.key; render(); };
          sortToggle.appendChild(el);
        });
        headRight.appendChild(sortToggle);
      }

      const countTag = document.createElement('div');
      countTag.className = 'count-tag';
      countTag.textContent = doneCount + '/' + totalCount;
      headRight.appendChild(countTag);

      head.appendChild(headRight);
      section.appendChild(head);

      if (totalCount === 0) {
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = 'Nenhum item ainda. Adicione o primeiro objetivo abaixo.';
        section.appendChild(hint);
      } else {
        if (openItems.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'empty-hint';
          hint.textContent = 'Nenhum item em aberto nesta lista.';
          section.appendChild(hint);
        } else {
          openItems.forEach(o => {
            if (editingId === o.id) {
              section.appendChild(buildEditRow(o, cat));
            } else {
              section.appendChild(buildItemRow(o, cat));
            }
          });
        }

        if (doneItems.length > 0) {
          const isExpanded = expandedDone.has(cat.key);
          const toggle = document.createElement('div');
          toggle.className = 'done-toggle' + (isExpanded ? ' expanded' : '');
          toggle.innerHTML = '<span class="done-toggle-arrow">▶</span> Concluídos (' + doneItems.length + ')';
          toggle.onclick = () => toggleDoneSection(cat.key);
          section.appendChild(toggle);

          const doneWrap = document.createElement('div');
          doneWrap.className = 'done-items-wrap' + (isExpanded ? ' expanded' : '');
          doneItems.forEach(o => {
            if (editingId === o.id) {
              doneWrap.appendChild(buildEditRow(o, cat));
            } else {
              doneWrap.appendChild(buildItemRow(o, cat));
            }
          });
          section.appendChild(doneWrap);
        }
      }

      host.appendChild(section);
    });
  }

  function getAvailableYears() {
    const years = new Set();
    objectives.forEach(o => {
      if (o.done && o.completedAt) years.add(new Date(o.completedAt).getFullYear());
    });
    return Array.from(years).sort((a, b) => b - a);
  }

  function populateYearSelect() {
    const select = document.getElementById('chartYearSelect');
    const years = getAvailableYears();
    const currentYear = new Date().getFullYear();

    // default to current year if it has data, otherwise 'all'
    if (!select.dataset.initialized) {
      selectedChartYear = years.includes(currentYear) ? currentYear : 'all';
      select.dataset.initialized = 'true';
    }
    // if previously selected year no longer has data, fall back to 'all'
    if (selectedChartYear !== 'all' && !years.includes(Number(selectedChartYear))) {
      selectedChartYear = 'all';
    }

    const options = ['<option value="all">Todos os anos (somado)</option>']
      .concat(years.map(y => '<option value="' + y + '">' + y + '</option>'));
    select.innerHTML = options.join('');
    select.value = String(selectedChartYear);
  }

  function computeMonthlyData(yearFilter) {
    const counts = Array.from({ length: 12 }, () => ({ urgente: 0, programe: 0, delegue: 0, livre: 0, sem: 0 }));
    objectives.forEach(o => {
      if (o.done && o.completedAt) {
        const d = new Date(o.completedAt);
        if (yearFilter !== 'all' && d.getFullYear() !== Number(yearFilter)) return;
        const m = d.getMonth();
        const key = (o.priority && counts[m][o.priority] !== undefined) ? o.priority : 'sem';
        counts[m][key]++;
      }
    });
    return counts;
  }

  function renderChartLegend() {
    const legend = document.getElementById('chartLegend');
    const items = [
      { label: 'Urgente', color: CHART_COLORS.urgente },
      { label: 'Se programe', color: CHART_COLORS.programe },
      { label: 'Delegue', color: CHART_COLORS.delegue },
      { label: 'Tempo livre', color: CHART_COLORS.livre },
      { label: 'Sem prioridade', color: CHART_COLORS.sem },
    ];
    legend.innerHTML = items.map(it =>
      '<div class="legend-item"><span class="legend-dot" style="background:' + it.color + '"></span>' + it.label + '</div>'
    ).join('');
  }

  function renderMonthChart() {
    populateYearSelect();
    const counts = computeMonthlyData(selectedChartYear);
    const totals = counts.map(c => c.urgente + c.programe + c.delegue + c.livre + c.sem);
    const maxTotal = Math.max.apply(null, totals.concat([1]));
    const host = document.getElementById('monthChart');
    host.innerHTML = '';

    const hasAny = totals.some(t => t > 0);
    document.getElementById('chartEmptyHint').style.display = hasAny ? 'none' : 'block';
    host.style.display = hasAny ? 'flex' : 'none';

    const order = ['urgente', 'programe', 'delegue', 'livre', 'sem'];

    MONTHS.forEach((label, i) => {
      const col = document.createElement('div');
      col.className = 'chart-col';

      const totalEl = document.createElement('div');
      totalEl.className = 'chart-total';
      totalEl.textContent = totals[i] > 0 ? totals[i] : '';
      col.appendChild(totalEl);

      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      const barHeightPx = totals[i] > 0 ? Math.max(6, Math.round((totals[i] / maxTotal) * 170)) : 0;
      bar.style.height = barHeightPx + 'px';

      order.forEach(key => {
        const val = counts[i][key];
        if (val > 0) {
          const seg = document.createElement('div');
          seg.className = 'chart-seg';
          seg.style.background = CHART_COLORS[key];
          seg.style.height = (val / totals[i] * 100) + '%';
          const pcfg = PRIORITIES.find(p => p.key === key);
          seg.title = val + ' - ' + (pcfg ? pcfg.label : 'Sem prioridade');
          bar.appendChild(seg);
        }
      });

      col.appendChild(bar);

      const monthLabel = document.createElement('div');
      monthLabel.className = 'chart-month-label';
      monthLabel.textContent = label;
      col.appendChild(monthLabel);

      host.appendChild(col);
    });
  }

  function renderPlanilha() {
    const total = objectives.length;
    const done = objectives.filter(o => o.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    document.getElementById('masterNum').innerHTML = done + ' <span>/ ' + total + ' concluídas</span>';
    document.getElementById('masterPct').textContent = pct + '%';
    document.getElementById('masterFill').style.width = pct + '%';

    const grid = document.getElementById('summaryGrid');
    grid.innerHTML = '';
    CATEGORIES.forEach(cat => {
      const items = objectives.filter(o => o.category === cat.key);
      const d = items.filter(o => o.done).length;
      const t = items.length;
      const p = t ? Math.round((d / t) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML =
        '<div class="stat-label">' + cat.label + '</div>' +
        '<div class="stat-value">' + d + ' <span style="font-size:13px;color:var(--muted);font-weight:400;">/ ' + t + '</span></div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + p + '%; background: linear-gradient(90deg, ' + cat.color + ', ' + cat.color + ')"></div></div>';
      grid.appendChild(card);
    });

    const body = document.getElementById('doneTableBody');
    const doneItems = objectives.filter(o => o.done);
    body.innerHTML = '';
    document.getElementById('doneCountTag').textContent = doneItems.length + ' itens';
    document.getElementById('doneEmptyHint').style.display = doneItems.length ? 'none' : 'block';

    doneItems
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach(o => {
        const cat = CATEGORIES.find(c => c.key === o.category);
        const tr = document.createElement('tr');
        const pcfg = PRIORITIES.find(p => p.key === o.priority);
        tr.innerHTML =
          '<td><span class="cat-pill" style="color:' + cat.color + '">' + cat.label + '</span></td>' +
          '<td>' + escapeHtml(o.text) + '</td>' +
          '<td>' + (pcfg ? '<span class="priority-badge ' + pcfg.key + '">' + pcfg.label + '</span>' : '—') + '</td>' +
          '<td>' + (o.dueDate ? formatDate(o.dueDate) : '—') + '</td>' +
          '<td class="status-ok">✓ concluída</td>';
        body.appendChild(tr);
      });
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function renderHistoryList() {
    const host = document.getElementById('historyList');
    const emptyHint = document.getElementById('historyEmptyHint');
    host.innerHTML = '';

    if (scoreHistory.length === 0) {
      emptyHint.style.display = 'block';
      return;
    }
    emptyHint.style.display = 'none';

    scoreHistory.slice(-10).reverse().forEach(entry => {
      const row = document.createElement('div');
      row.className = 'history-item';

      const delta = document.createElement('div');
      delta.className = 'history-delta ' + (entry.delta > 0 ? 'positive' : 'negative');
      delta.textContent = (entry.delta > 0 ? '+' : '') + entry.delta;

      const reason = document.createElement('div');
      reason.className = 'history-reason';
      reason.textContent = entry.reason;

      const time = document.createElement('div');
      time.className = 'history-time';
      time.textContent = formatDateTime(entry.timestamp);

      row.appendChild(delta);
      row.appendChild(reason);
      row.appendChild(time);
      host.appendChild(row);
    });
  }

  function shortDateLabel(ts) {
    const d = new Date(ts);
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function renderScoreLineChart() {
    const host = document.getElementById('scoreLineChartHost');
    const axisHost = document.getElementById('scoreYAxis');
    const emptyHint = document.getElementById('scoreChartEmptyHint');
    host.innerHTML = '';
    axisHost.innerHTML = '';

    if (scoreHistory.length === 0) {
      emptyHint.style.display = 'block';
      return;
    }
    emptyHint.style.display = 'none';

    const points = [{ balance: INITIAL_SCORE, timestamp: null }].concat(scoreHistory);
    const balances = points.map(p => p.balance);
    const minB = Math.min.apply(null, balances);
    const maxB = Math.max.apply(null, balances);
    const range = (maxB - minB) || 1;

    const containerWidth = 700;
    const maxVisible = 10;
    const height = 280;
    const padTop = 28, padBottom = 40;
    const axisWidth = 50;
    const chartPadLeft = 16, chartPadRight = 16;
    const innerWidth = containerWidth - chartPadLeft - chartPadRight;

    let chartWidth, stepX;
    if (points.length <= maxVisible) {
      chartWidth = containerWidth;
      stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0;
    } else {
      stepX = innerWidth / (maxVisible - 1);
      chartWidth = chartPadLeft + chartPadRight + stepX * (points.length - 1);
    }
    const usableH = height - padTop - padBottom;

    function xAt(i) { return chartPadLeft + stepX * i; }
    function yAt(v) { return padTop + usableH - ((v - minB) / range) * usableH; }

    // --- Fixed Y-axis panel (does not scroll) ---
    const tickCount = 4;
    let axisTicks = '';
    let gridLines = '';
    for (let t = 0; t <= tickCount; t++) {
      const value = minB + (range * t / tickCount);
      const y = yAt(value);
      axisTicks += '<text x="' + (axisWidth - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" font-family="IBM Plex Mono, monospace" fill="var(--muted)">' + Math.round(value) + '</text>';
      gridLines += '<line x1="0" y1="' + y.toFixed(1) + '" x2="' + chartWidth + '" y2="' + y.toFixed(1) + '" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="3,3"/>';
    }
    const axisSvg =
      '<svg width="' + axisWidth + '" height="' + height + '" viewBox="0 0 ' + axisWidth + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
        '<line x1="' + (axisWidth - 1) + '" y1="' + padTop + '" x2="' + (axisWidth - 1) + '" y2="' + (height - padBottom) + '" stroke="var(--line)" stroke-width="1"/>' +
        axisTicks +
      '</svg>';
    axisHost.innerHTML = axisSvg;

    // --- Scrollable plot panel ---
    let pathD = '';
    points.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.balance);
      pathD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    });
    const areaD = pathD + 'L' + xAt(points.length - 1).toFixed(1) + ',' + (height - padBottom).toFixed(1) +
            ' L' + xAt(0).toFixed(1) + ',' + (height - padBottom).toFixed(1) + ' Z';

    let circles = '';
    let valueLabels = '';
    let dateLabels = '';
    points.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.balance);
      const isBaseline = (i === 0);
      const color = isBaseline ? 'var(--muted)' : (p.delta > 0 ? 'var(--green)' : 'var(--danger)');

      if (!isBaseline) {
        const title = (p.delta > 0 ? '+' : '') + p.delta + ' — ' + p.reason;
        circles += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" fill="' + color + '"><title>' + escapeHtml(title) + '</title></circle>';
      } else {
        circles += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + color + '"><title>Saldo inicial: ' + INITIAL_SCORE + '</title></circle>';
      }

      valueLabels += '<text x="' + x.toFixed(1) + '" y="' + (y - 9).toFixed(1) + '" text-anchor="middle" font-size="10" font-family="IBM Plex Mono, monospace" fill="' + color + '" font-weight="600">' + p.balance + '</text>';

      const dateText = isBaseline ? 'Início' : shortDateLabel(p.timestamp);
      dateLabels += '<text x="' + x.toFixed(1) + '" y="' + (height - padBottom + 16).toFixed(1) + '" text-anchor="middle" font-size="9.5" font-family="IBM Plex Mono, monospace" fill="var(--muted)">' + dateText + '</text>';
    });

    const chartSvg =
      '<svg class="score-line-svg" viewBox="0 0 ' + chartWidth + ' ' + height + '" width="' + chartWidth + '" height="' + height + '" style="width:' + chartWidth + 'px;height:' + height + 'px;" xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="scoreAreaGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="var(--amber)" stop-opacity="0.28"/>' +
          '<stop offset="100%" stop-color="var(--amber)" stop-opacity="0"/>' +
        '</linearGradient></defs>' +
        gridLines +
        '<path d="' + areaD + '" fill="url(#scoreAreaGrad)" stroke="none"/>' +
        '<path d="' + pathD + '" fill="none" stroke="var(--amber)" stroke-width="2"/>' +
        circles +
        valueLabels +
        dateLabels +
      '</svg>';

    host.innerHTML = chartSvg;
    host.scrollLeft = host.scrollWidth;
  }

  function renderScoreTab() {
    const valueEl = document.getElementById('scoreMegaValue');
    valueEl.textContent = score;
    valueEl.classList.remove('up', 'down');
    if (score > INITIAL_SCORE) valueEl.classList.add('up');
    else if (score < INITIAL_SCORE) valueEl.classList.add('down');

    renderHistoryList();
    renderScoreLineChart();
  }

  function renderScoreBanner() {
    const valueEl = document.getElementById('scoreValue');
    valueEl.textContent = score;
    valueEl.classList.remove('up', 'down');
    if (score > INITIAL_SCORE) valueEl.classList.add('up');
    else if (score < INITIAL_SCORE) valueEl.classList.add('down');

    const doneCount = objectives.filter(o => o.done).length;
    const failedCount = objectives.filter(o => o.failed || o.autoPenalized).length;
    document.getElementById('scoreDoneBadge').textContent = doneCount + ' concluído' + (doneCount === 1 ? '' : 's');
    document.getElementById('scoreFailedBadge').textContent = failedCount + ' não cumprido' + (failedCount === 1 ? '' : 's');
  }

  function render() {
    if (!ready) return;
    applyAutoPenalties();
    renderSections();
    renderPlanilha();
    renderChartLegend();
    renderMonthChart();
    renderScoreBanner();
    renderScoreTab();
  }

  function catLabelToKey(label) {
    const found = CATEGORIES.find(c => c.label.trim().toLowerCase() === String(label || '').trim().toLowerCase());
    return found ? found.key : 'gerais';
  }

  function setStatus(msg) {
    document.getElementById('excelStatus').textContent = msg;
  }

  function priorityKeyToLabel(key) {
    const p = PRIORITIES.find(p => p.key === key);
    return p ? p.label : '';
  }

  function priorityLabelToKey(label) {
    const p = PRIORITIES.find(p => p.label.trim().toLowerCase() === String(label || '').trim().toLowerCase());
    return p ? p.key : '';
  }

  let savedFileHandle = null;

  function buildWorkbook() {
    const rows = objectives.map(o => {
      const cat = CATEGORIES.find(c => c.key === o.category);
      return {
        'Categoria': cat ? cat.label : o.category,
        'Tarefa': o.text,
        'Descrição': o.description || '',
        'Concluída': o.done ? 'Sim' : 'Não',
        'Prazo': o.dueDate || '',
        'Prioridade': priorityKeyToLabel(o.priority),
        'Criado em': new Date(o.createdAt || Date.now()).toISOString(),
        'Concluído em': o.completedAt ? new Date(o.completedAt).toISOString() : '',
        'Não cumprido': o.failed ? 'Sim' : 'Não',
        'Penalizado automaticamente': o.autoPenalized ? 'Sim' : 'Não',
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows, { header: ['Categoria', 'Tarefa', 'Descrição', 'Concluída', 'Prazo', 'Prioridade', 'Criado em', 'Concluído em', 'Não cumprido', 'Penalizado automaticamente'] });
    ws['!cols'] = [{ wch: 32 }, { wch: 50 }, { wch: 50 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 14 }, { wch: 22 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Objetivos');

    const scoreWs = XLSX.utils.json_to_sheet([{ 'Saldo Atual': score, 'Saldo Inicial': INITIAL_SCORE }]);
    scoreWs['!cols'] = [{ wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, scoreWs, 'Pontuacao');

    const historyRows = scoreHistory.map(h => ({
      'Data': new Date(h.timestamp).toISOString(),
      'Variação': h.delta,
      'Motivo': h.reason,
      'Saldo após': h.balance,
    }));
    const historyWs = XLSX.utils.json_to_sheet(historyRows, { header: ['Data', 'Variação', 'Motivo', 'Saldo após'] });
    historyWs['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, historyWs, 'Historico');

    return { wb, count: rows.length };
  }

  async function exportToExcel() {
    const { wb, count } = buildWorkbook();

    if (window.showSaveFilePicker) {
      try {
        if (!savedFileHandle) {
          savedFileHandle = await window.showSaveFilePicker({
            suggestedName: 'Objetivos.xlsx',
            types: [{
              description: 'Planilha Excel',
              accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] },
            }],
          });
        }
        const arrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const writable = await savedFileHandle.createWritable();
        await writable.write(arrayBuffer);
        await writable.close();
        setStatus('salvo offline, ' + count + ' itens (sobrescrito automaticamente) — ' + new Date().toLocaleTimeString('pt-BR'));
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          setStatus('salvamento cancelado');
          return;
        }
        console.warn('File System Access falhou, caindo para download padrão', err);
        savedFileHandle = null;
      }
    }

    // Fallback: navegador sem suporte à File System Access API
    XLSX.writeFile(wb, 'Objetivos.xlsx');
    setStatus('baixado (' + count + ' itens) — verifique a pasta Downloads do navegador');
  }

  function stateFromWorkbook(wb) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const newObjectives = rows
      .filter(r => (r['Tarefa'] || '').toString().trim().length > 0)
      .map(r => {
        const createdRaw = r['Criado em'];
        const parsed = createdRaw ? Date.parse(createdRaw) : NaN;
        const prazoRaw = (r['Prazo'] || '').toString().trim();
        const completedRaw = r['Concluído em'];
        const completedParsed = completedRaw ? Date.parse(completedRaw) : NaN;
        const isDone = String(r['Concluída'] || '').trim().toLowerCase() === 'sim';
        return {
          id: uid(),
          category: catLabelToKey(r['Categoria']),
          text: (r['Tarefa'] || '').toString().trim(),
          description: (r['Descrição'] || '').toString().trim(),
          done: isDone,
          createdAt: isNaN(parsed) ? Date.now() : parsed,
          dueDate: prazoRaw || null,
          priority: priorityLabelToKey(r['Prioridade']),
          completedAt: isDone ? (isNaN(completedParsed) ? (isNaN(parsed) ? Date.now() : parsed) : completedParsed) : null,
          failed: String(r['Não cumprido'] || '').trim().toLowerCase() === 'sim',
          autoPenalized: String(r['Penalizado automaticamente'] || '').trim().toLowerCase() === 'sim',
        };
      });

    let newScore = INITIAL_SCORE;
    const scoreSheet = wb.Sheets['Pontuacao'];
    if (scoreSheet) {
      const scoreRows = XLSX.utils.sheet_to_json(scoreSheet, { defval: '' });
      if (scoreRows.length && typeof scoreRows[0]['Saldo Atual'] === 'number') {
        newScore = scoreRows[0]['Saldo Atual'];
      }
    }

    let newHistory = [];
    const historySheet = wb.Sheets['Historico'];
    if (historySheet) {
      const historyRows = XLSX.utils.sheet_to_json(historySheet, { defval: '' });
      newHistory = historyRows
        .filter(h => h['Motivo'])
        .map(h => {
          const ts = Date.parse(h['Data']);
          return {
            id: uid(),
            timestamp: isNaN(ts) ? Date.now() : ts,
            delta: typeof h['Variação'] === 'number' ? h['Variação'] : 0,
            reason: String(h['Motivo'] || ''),
            balance: typeof h['Saldo após'] === 'number' ? h['Saldo após'] : newScore,
          };
        });
    }

    return { objectives: newObjectives, score: newScore, history: newHistory };
  }

  const REPO_EXCEL_FILENAME = 'Objetivos.xlsx';

  async function tryAutoLoadFromRepo() {
    try {
      const resp = await fetch(REPO_EXCEL_FILENAME, { cache: 'no-store' });
      if (!resp.ok) return false;
      const buffer = await resp.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const parsed = stateFromWorkbook(wb);
      objectives = parsed.objectives;
      score = parsed.score;
      scoreHistory = parsed.history;
      setStatus('planilha do repositório carregada automaticamente (' + objectives.length + ' itens, ' + score + ' pts)');
      return true;
    } catch (e) {
      return false;
    }
  }

  function importFromExcelFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const parsed = stateFromWorkbook(wb);
        objectives = parsed.objectives;
        score = parsed.score;
        scoreHistory = parsed.history;

        save();
        render();
        setStatus('carregado de Excel (' + objectives.length + ' itens, ' + score + ' pts) — ' + new Date().toLocaleTimeString('pt-BR'));
      } catch (err) {
        setStatus('erro ao ler o arquivo — verifique o formato');
        console.error(err);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  document.getElementById('exportBtn').onclick = exportToExcel;

  document.getElementById('chartYearSelect').onchange = (e) => {
    selectedChartYear = e.target.value === 'all' ? 'all' : Number(e.target.value);
    renderMonthChart();
  };

  // --- Quick-add FAB ---
  (function setupFab() {
    const fabBtn = document.getElementById('fabBtn');
    const fabPopup = document.getElementById('fabPopup');
    const fabClose = document.getElementById('fabClose');
    const fabCategory = document.getElementById('fabCategory');
    const fabText = document.getElementById('fabText');
    const fabDescription = document.getElementById('fabDescription');
    const fabDate = document.getElementById('fabDate');
    const fabPriority = document.getElementById('fabPriority');
    const fabAddBtn = document.getElementById('fabAddBtn');

    CATEGORIES.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.key;
      opt.textContent = cat.label;
      fabCategory.appendChild(opt);
    });

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Sem prioridade';
    fabPriority.appendChild(noneOpt);
    PRIORITIES.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      fabPriority.appendChild(opt);
    });

    function updateDateVisibility() {
      fabDate.style.display = 'block';
    }
    updateDateVisibility();

    function openPopup() {
      fabPopup.classList.add('open');
      fabText.focus();
    }
    function closePopup() {
      fabPopup.classList.remove('open');
    }

    fabBtn.onclick = () => {
      if (fabPopup.classList.contains('open')) closePopup();
      else openPopup();
    };
    fabClose.onclick = closePopup;

    function doFabAdd() {
      if (!fabText.value.trim()) { fabText.focus(); return; }
      addObjective(fabCategory.value, fabText.value, fabDate.value, fabPriority.value, fabDescription.value);
      fabText.value = '';
      fabDate.value = '';
      fabDescription.value = '';
      fabText.focus();
    }

    fabAddBtn.onclick = doFabAdd;
    fabText.onkeydown = (e) => {
      if (e.key === 'Enter') doFabAdd();
      if (e.key === 'Escape') closePopup();
    };
  })();
  document.getElementById('fileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) importFromExcelFile(file);
    e.target.value = '';
  };

  function switchToTab(pageName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const targetTab = document.querySelector('.tab[data-page="' + pageName + '"]');
    if (targetTab) targetTab.classList.add('active');
    const targetPage = document.getElementById('page-' + pageName);
    if (targetPage) targetPage.classList.add('active');

    const banner = document.querySelector('.score-banner');
    if (banner) banner.style.display = pageName === 'score' ? 'none' : '';
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchToTab(tab.dataset.page);
  });

  document.getElementById('headerBanner').onclick = () => switchToTab('objetivos');

  document.getElementById('scoreRightGroup').onclick = () => {
    // Only active in the desktop rearranged layout; mobile keeps its current behavior untouched.
    if (window.innerWidth >= 1000) switchToTab('score');
  };

  document.addEventListener('click', () => {
    let changed = false;
    if (openMenuId !== null) { openMenuId = null; changed = true; }
    if (descOpenId !== null) { descOpenId = null; changed = true; }
    if (changed) render();
  });

  load();
})();
