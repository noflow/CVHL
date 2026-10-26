/* A league's website UI; account service access uses league-scoped bearer sessions. */
(() => {
  'use strict';
  const config = document.querySelector('script[data-player-league]');
  if (!config) return;
  const league = config.dataset.playerLeague;
  const service = config.dataset.playerService.replace(/\/$/, '');
  if (!league || !service) return;
  const storageKey = 'player-session:' + league;
  const verifierKey = 'player-verifier:' + league;
  const labels = {available:'Available', unavailable:'Unavailable', maybe:'Maybe', none:'No response'};
  const E = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  let token = sessionStorage.getItem(storageKey) || '';
  let profile;
  let tab = 'profile';
  let notice = '';
  let active = false;
  let busy = false;
  let viewGeneration = 0;
  const root = document.createElement('section');
  root.id = 'player-centre';
  const page = document.createElement('div');
  page.id = 'page-profile';
  page.className = 'page';
  page.appendChild(root);
  document.querySelector('main').appendChild(page);

  // Read the actual enclosing site's background to select its existing light/dark tokens.
  const colour = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  if (colour && colour.length >= 3) root.dataset.dark = (Number(colour[0])*.2126 + Number(colour[1])*.7152 + Number(colour[2])*.0722 < 110) ? 'true' : 'false';

  function shell(content) {
    root.innerHTML = `<div class="pc-head"><div><h2>My Profile & Availability</h2><p class="pc-muted">Your player. Your team. Your next game.</p></div>${profile ? `<div class="pc-actions"><span>${E(profile.name)}</span><button type="button" data-command="logout">Sign out</button></div>` : ''}</div>${notice ? `<div class="pc-notice" role="status">${E(notice)}</div>` : ''}${profile?.management ? `<div class="pc-tabs" role="tablist" aria-label="Player area"><button type="button" role="tab" aria-selected="${tab==='profile'}" data-command="profile">My Profile</button><button type="button" role="tab" aria-selected="${tab==='team'}" data-command="team">Team Availability</button></div>` : ''}<div id="pc-content">${content}</div>`;
  }
  function message(text, error=false) { shell(`<div class="pc-card pc-notice" role="${error ? 'alert':'status'}">${E(text)}</div>`); }
  function signedOut() { profile = null; shell('<div class="pc-card"><h3>Your player area, right here</h3><p>Sign in with Discord to claim your player, update your profile, and tell your team which games you can play.</p><button type="button" data-command="login">Sign in with Discord</button><p class="pc-muted">Discord opens briefly for sign-in, then returns you to this website. Already connected to an existing account? Use that same Discord login.</p></div>'); }
  async function call(path, data) {
    const response = await fetch(`${service}/api/website/${encodeURIComponent(league)}/${path}`, {
      method: data ? 'POST':'GET', credentials:'omit', cache:'no-store',
      headers:{Authorization:'Bearer '+token}, body:data ? new URLSearchParams(data):undefined
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('The account service is temporarily unavailable. Please try again.'); }
    if (!response.ok) {
      if (response.status === 401) { token=''; profile=null; sessionStorage.removeItem(storageKey); }
      throw new Error(result.error || 'Please try again.');
    }
    return result;
  }
  async function signIn() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const base64 = value => btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const verifier = base64(bytes);
    sessionStorage.setItem(verifierKey, verifier);
    const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    location.assign(`${service}/website/auth/${encodeURIComponent(league)}?challenge=${challenge}`);
  }
  async function exchange() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (!params.has('code')) return;
    const code = params.get('code');
    history.replaceState(null,'','#profile');
    const verifier = sessionStorage.getItem(verifierKey) || '';
    sessionStorage.removeItem(verifierKey);
    if (!verifier) throw new Error('This sign-in has expired. Start again from this website.');
    const response = await fetch(`${service}/api/website/${encodeURIComponent(league)}/session`, {
      method:'POST',credentials:'omit',cache:'no-store',body:new URLSearchParams({code,verifier})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in could not finish. Please try again.');
    token = result.token;
    sessionStorage.setItem(storageKey,token);
  }
  const hidden = (name,value) => `<input type="hidden" name="${name}" value="${E(value)}">`;
  const option = (value,label,current) => `<option value="${E(value)}" ${value===current?'selected':''}>${E(label)}</option>`;
  const pill = (status,count='') => `<span class="pc-pill ${Object.hasOwn(labels,status)?status:'none'}">${E(count)} ${E(labels[status] || labels.none)}</span>`;
  function profileView(p) {
    if (!p.joined) return '<div class="pc-card"><h3>Join this league</h3><p>Join as a player, then claim your player record.</p><form data-action="join"><button>Join league</button></form></div>';
    let player;
    if (p.link) {
      player = `<h3>${E(p.link.name)}</h3><span class="pc-pill available">Verified player</span>${p.player ? `<dl><dt>Current team</dt><dd>${E(p.player.team_name || p.player.team)}</dd><dt>Roster</dt><dd>${E(p.player.section_label)}</dd><dt>Position</dt><dd>${E(p.player.position || 'Not listed')}</dd><dt>Salary</dt><dd>${E(Number(p.player.salary || 0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}))}</dd></dl>`:'<p class="pc-muted">Your player needs a unique current team assignment before you can submit availability.</p>'}`;
    } else {
      player = `<h3>Claim my player</h3><p>League staff verify your claim before you can submit availability.</p>${p.claim ? `<p>Claim: <strong>${E(p.claim.name)}</strong> · ${E(p.claim.status)}</p>`:''}${p.choices.length ? `<form data-action="claim"><label>My player<select name="player_key" required><option value="">Select your player</option>${p.choices.map(c=>option(c.key,c.name,'')).join('')}</select></label><button>Submit player claim</button></form>`:'<p class="pc-muted">Contact league staff if your player is missing.</p>'}`;
    }
    const d = p.details;
    const details = `<h3>My Details</h3><p class="pc-muted">Private profile details. Official roster information stays managed by league staff.</p><form data-action="details"><label>Gamertag<input name="gamertag" maxlength="80" value="${E(d.gamertag)}"></label><label>Platform<select name="platform">${['','Xbox','PlayStation','PC'].map(v=>option(v,v || 'Select platform',d.platform || '')).join('')}</select></label><label>Preferred positions<input name="positions" maxlength="80" placeholder="C, LW, RD" value="${E(d.positions)}"></label><button>Save my details</button></form>`;
    const stats = p.link ? `<div class="pc-card"><h3>My Published Season Stats</h3>${p.stats.length ? p.stats.map(s=>`<p>${E(s.label)} · ${E(s.team)}</p><dl>${s.metrics.map(([k,v])=>`<dt>${E(k)}</dt><dd>${E(v)}</dd>`).join('')}</dl>`).join(''):'<p class="pc-muted">Your published stats will appear here once available.</p>'}</div>`:'';
    const games = !p.link ? '<div class="pc-card">Your player claim needs approval before you can submit availability.</div>' : !p.player ? '<div class="pc-card">Availability will appear once your player is assigned to a team.</div>' : p.games.length ? p.games.map(g=>`<div class="pc-card pc-columns"><div><p class="pc-muted">${E(g.date)} · ${E(g.time || 'Time TBA')} · ${E(g.timezone)}</p><h3>${E(g.away)} at ${E(g.home)}</h3>${pill(g.response.status)}</div><form data-action="availability">${hidden('game_key',g.key)}<label>My response<select name="status">${Object.entries(labels).map(([k,v])=>option(k,v,g.response.status)).join('')}</select></label><label>Note for team management (optional)<textarea name="note" maxlength="300" rows="2">${E(g.response.note)}</textarea></label><button>Save availability</button></form></div>`).join('') : '<div class="pc-card">No upcoming team games are scheduled in the next 28 days.</div>';
    return `${p.error ? `<div class="pc-notice" role="alert">${E(p.error)}</div>`:''}<div class="pc-columns"><div class="pc-card">${player}</div><div class="pc-card">${details}</div></div>${stats}<h3>My Availability</h3><p class="pc-muted">Next 28 days · Replies close at game time. Responses and notes are private to you, current team management, and league admins.</p>${games}`;
  }
  function teamView(t) {
    const selector = t.admin ? `<div class="pc-card"><form data-team-selector><label>Team<select name="team">${t.teams.map(v=>option(v.abbr,v.name,t.selected_team)).join('')}</select></label><button>View team</button></form></div>` : `<p>Team: <strong>${E(t.selected_team)}</strong></p>`;
    return `${selector}${t.error ? `<div class="pc-notice" role="alert">${E(t.error)}</div>`:''}<p class="pc-muted">Every current roster and TC player is included. Open a game to plan your lineup.</p>${t.games.map((g,i)=>`<details class="pc-card" ${i===0?'open':''}><summary><strong>${E(g.date)} · ${E(g.time)} · ${E(g.away)} at ${E(g.home)}</strong><div class="pc-totals">${Object.entries(labels).map(([k])=>pill(k,g.totals[k])).join('')}</div></summary><p class="pc-muted">Times: ${E(g.timezone)}</p><div class="pc-table"><table><thead><tr><th>Player</th><th>Position</th><th>Roster</th><th>Response</th><th>Note</th></tr></thead><tbody>${g.players.map(p=>`<tr><td>${E(p.name)}${p.linked?'':'<small>Account not linked</small>'}</td><td>${E(p.position || '—')}</td><td>${E(p.section_label)}</td><td>${pill(p.response.status)}</td><td>${E(p.response.note)}</td></tr>`).join('')}</tbody></table></div></details>`).join('') || '<div class="pc-card">No upcoming games for this team in the next 28 days.</div>'}`;
  }
  async function load(team='') {
    const generation = ++viewGeneration;
    if (!token) { signedOut(); return; }
    try {
      message('Loading your player area…');
      if (!profile || tab==='profile') profile = await call('profile');
      const content = tab==='team' ? teamView(await call('team'+(team?'?team='+encodeURIComponent(team):''))) : profileView(profile);
      if (active && generation===viewGeneration) shell(content);
    } catch(error) {
      if (generation!==viewGeneration) return;
      if (!token) { notice=error.message; signedOut(); }
      else message(error.message,true);
    }
  }
  async function open() {
    const isProfile = location.hash.split('?')[0]==='#profile';
    if (!isProfile) {
      if (active) {
        active=false;page.classList.remove('active');
        const id=location.hash.slice(1) || 'home';
        if (['home','standings','players','goalies','teams','schedule','bracket','games'].includes(id) && typeof window.showPage==='function') {
          window.showPage(id,document.querySelector(`nav button[onclick*="'${id}'"]`));
        }
      }
      return;
    }
    active=true;
    if (typeof window.setMobileMenuOpen==='function') window.setMobileMenuOpen(false);
    document.querySelectorAll('main > .page').forEach(p=>p.classList.toggle('active',p===page));
    document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
    page.classList.add('active');
    try { await exchange(); await load(); } catch(error) {notice=error.message;signedOut();}
  }
  const links = [...document.querySelectorAll('a.player-centre-nav, #player-signup-link')];
  links.forEach(link=>{link.href='#profile';link.addEventListener('click',event=>{event.preventDefault();if(location.hash==='#profile')open();else location.hash='profile';});});
  root.addEventListener('click',async event=>{
    const command=event.target.closest('[data-command]')?.dataset.command;
    if (!command || busy) return;
    if (command==='login') {try {await signIn();} catch {message('Sign-in could not start. Please enable website storage and try again.',true);}return;}
    if (command==='logout') {try {await call('action/logout',{});} catch {} token='';profile=null;sessionStorage.removeItem(storageKey);notice='';signedOut();return;}
    tab=command;notice='';await load();
  });
  root.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const form=event.target;
    if(form.hasAttribute('data-team-selector')) {await load(new FormData(form).get('team'));return;}
    busy=true;
    form.querySelector('button').disabled=true;
    try {await call('action/'+form.dataset.action,Object.fromEntries(new FormData(form)));notice='Saved.';await load();}
    catch(error) {notice=error.message;await load();}
    finally {busy=false;if(form.isConnected)form.querySelector('button').disabled=false;}
  });
  window.addEventListener('hashchange',open);
  open();
})();
