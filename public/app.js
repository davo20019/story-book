const form = document.querySelector('#generate-form');
const promptInput = document.querySelector('#prompt-input');
const pageCountInput = document.querySelector('#page-count');
const statusEl = document.querySelector('#status');
const storiesShelf = document.querySelector('#stories-shelf');
const dictateBtn = document.querySelector('#dictate-btn');
const loadingIndicator = document.querySelector('#loading-indicator');

// Reader elements
const readerEmpty = document.querySelector('#reader-empty');
const readerActive = document.querySelector('#reader-active');
const readerTitle = document.querySelector('#reader-title');
const readerPrompt = document.querySelector('#reader-prompt');
const bookPageDisplay = document.querySelector('#book-page-display');
const bookPageImg = document.querySelector('#book-page-img');
const bookPageNumber = document.querySelector('#book-page-number');
const bookPageText = document.querySelector('#book-page-text');
const prevPageBtn = document.querySelector('#prev-page');
const nextPageBtn = document.querySelector('#next-page');
const pageDotsContainer = document.querySelector('#page-dots');

// Tab elements
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

const CARD_COLORS = ['coral', 'teal', 'lavender', 'sunshine', 'mint'];
const CARD_ICONS = ['\u{1F4D6}', '\u{1F31F}', '\u{1F98A}', '\u{1F319}', '\u{1F308}', '\u{1F43B}', '\u{1F98B}', '\u{1F3F0}', '\u{1F680}', '\u{1F338}', '\u{1F409}', '\u{1F9F8}'];

const surpriseBtn = document.querySelector('#surprise-btn');
const addPhotoBtn = document.querySelector('#add-photo-btn');
const photoUploads = document.querySelector('#photo-uploads');
const voiceSelect = document.querySelector('#voice-select');

const state = {
  stories: [],
  activeStory: null,
  currentPage: 0,
  loading: false,
  reading: false,
  readingUtterance: null,
  turnstileSiteKey: null,
  turnstileWidgetId: null,
  characterPhotos: [], // { base64, mimeType, description }
  selectedVoiceURI: null,
};

boot();

async function boot() {
  configureSpeechRecognition();
  bindEvents();
  await loadConfig();
  await loadStories();
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();

    if (config.turnstileSiteKey) {
      state.turnstileSiteKey = config.turnstileSiteKey;
      loadTurnstileScript(config.turnstileSiteKey);
    }
  } catch {
    // Config fetch failed — Turnstile will be skipped
  }
}

function loadTurnstileScript(siteKey) {
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
  script.async = true;

  window.onTurnstileLoad = () => {
    const container = document.querySelector('#turnstile-container');
    if (container && window.turnstile) {
      state.turnstileWidgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        size: 'compact',
        appearance: 'interaction-only',
        'refresh-expired': 'auto',
      });
    }
  };

  document.head.appendChild(script);
}

function getTurnstileToken() {
  if (!state.turnstileSiteKey || !window.turnstile || state.turnstileWidgetId == null) {
    return null;
  }
  return window.turnstile.getResponse(state.turnstileWidgetId) || null;
}

function resetTurnstile() {
  if (window.turnstile && state.turnstileWidgetId != null) {
    window.turnstile.reset(state.turnstileWidgetId);
  }
}

// ---- Surprise me ----
const SURPRISE_PROMPT = 'Surprise me! Invent a completely original, fun, and imaginative children\'s story. Pick unexpected characters, a unique setting, and a heartwarming twist. Be creative!';

// ---- Photo uploads ----
function addPhotoEntry() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const mimeType = file.type || 'image/jpeg';

      const entry = { base64, mimeType, description: '' };
      state.characterPhotos.push(entry);
      renderPhotoEntry(entry, dataUrl);
    };
    reader.readAsDataURL(file);
  });

  fileInput.click();
}

function renderPhotoEntry(entry, dataUrl) {
  const row = document.createElement('div');
  row.className = 'photo-entry';

  const img = document.createElement('img');
  img.className = 'photo-entry-preview';
  img.src = dataUrl;
  img.alt = 'Uploaded character photo';
  row.appendChild(img);

  const fields = document.createElement('div');
  fields.className = 'photo-entry-fields';

  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.placeholder = 'Describe this: e.g. "Bella, my daughter" or "our cat Max"';
  descInput.addEventListener('input', () => {
    entry.description = descInput.value;
  });
  fields.appendChild(descInput);
  row.appendChild(fields);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'photo-entry-remove';
  removeBtn.textContent = '\u00D7';
  removeBtn.addEventListener('click', () => {
    const idx = state.characterPhotos.indexOf(entry);
    if (idx !== -1) state.characterPhotos.splice(idx, 1);
    row.remove();
  });
  row.appendChild(removeBtn);

  photoUploads.appendChild(row);

  // Focus the description field
  descInput.focus();
}

function getCharacterPhotosPayload() {
  return state.characterPhotos
    .filter(p => p.base64)
    .map(p => ({
      base64: p.base64,
      mimeType: p.mimeType,
      description: p.description.trim(),
    }));
}

function bindEvents() {
  // Tab navigation
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // Form submit
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.loading) return;

    const prompt = promptInput.value.trim();
    const pageCount = Number.parseInt(pageCountInput.value, 10);

    if (!prompt) {
      setStatus('Oops! Write a story idea first.');
      return;
    }

    setLoading(true);
    setStatus('');

    const turnstileToken = getTurnstileToken();
    if (state.turnstileSiteKey && !turnstileToken) {
      setStatus('Please complete the verification first.');
      setLoading(false);
      return;
    }

    try {
      const body = { prompt, pageCount };
      if (turnstileToken) {
        body.turnstileToken = turnstileToken;
      }
      const photos = getCharacterPhotosPayload();
      if (photos.length > 0) {
        body.referenceImages = photos;
      }

      const response = await fetch('/api/stories/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Generation failed.');
      }

      const { story } = payload;
      state.activeStory = story;
      state.currentPage = 0;
      setStatus('');

      await loadStories();
      renderReader();
      switchTab('reader');
      celebrateSparkles();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Generation failed.');
    } finally {
      setLoading(false);
      resetTurnstile();
    }
  });

  // Surprise me
  surpriseBtn.addEventListener('click', () => {
    if (state.loading) return;
    promptInput.value = SURPRISE_PROMPT;
    form.requestSubmit();
  });

  // Photo uploads
  addPhotoBtn.addEventListener('click', () => addPhotoEntry());

  // Voice picker — hot-swap while reading
  voiceSelect.addEventListener('change', () => {
    state.selectedVoiceURI = voiceSelect.value || null;
    cachedVoice = null;

    if (state.reading) {
      const currentPage = state.currentPage;
      const pages = getSortedPages();
      // Detach callbacks before canceling so stopReading isn't triggered
      if (state.readingUtterance) {
        state.readingUtterance.onend = null;
        state.readingUtterance.onerror = null;
      }
      window.speechSynthesis.cancel();
      readPageAloud(currentPage, pages);
    }
  });

  // Page navigation
  prevPageBtn.addEventListener('click', () => goToPage(state.currentPage - 1));
  nextPageBtn.addEventListener('click', () => goToPage(state.currentPage + 1));

  // Keyboard navigation for reader
  document.addEventListener('keydown', (e) => {
    const readerPanel = document.querySelector('#panel-reader');
    if (!readerPanel.classList.contains('active') || !state.activeStory) return;

    if (e.key === 'ArrowLeft') goToPage(state.currentPage - 1);
    if (e.key === 'ArrowRight') goToPage(state.currentPage + 1);
  });
}

function switchTab(tabName) {
  stopReading();

  for (const btn of tabButtons) {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  }

  for (const panel of tabPanels) {
    const isActive = panel.id === `panel-${tabName}`;
    panel.classList.toggle('active', isActive);
  }
}

function configureSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!Recognition) return;

  dictateBtn.hidden = false;
  const recognition = new Recognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  dictateBtn.addEventListener('click', () => {
    try {
      recognition.start();
      setStatus('Listening...');
    } catch {
      // Ignore repeated start() errors
    }
  });

  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) return;

    const spacer = promptInput.value.trim().length ? ' ' : '';
    promptInput.value = `${promptInput.value.trim()}${spacer}${transcript}`.trim();
    setStatus('Voice input added!');
  };

  recognition.onerror = () => {
    setStatus('Voice input failed. Try typing instead!');
  };
}

async function loadStories() {
  try {
    const response = await fetch('/api/stories');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Could not load stories.');
    }

    state.stories = payload.stories || [];
    renderStoriesShelf();

    if (!state.activeStory && state.stories.length > 0) {
      await openStory(state.stories[0].id);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not load stories.');
  }
}

function renderStoriesShelf() {
  // Clear existing content safely
  while (storiesShelf.firstChild) {
    storiesShelf.removeChild(storiesShelf.firstChild);
  }

  if (state.stories.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'shelf-empty';
    const p = document.createElement('p');
    p.textContent = 'No stories yet \u2014 go create your first one!';
    emptyDiv.appendChild(p);
    storiesShelf.appendChild(emptyDiv);
    return;
  }

  state.stories.forEach((story, index) => {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.dataset.color = CARD_COLORS[index % CARD_COLORS.length];
    card.addEventListener('click', () => openStory(story.id));

    // Cover
    const coverDiv = document.createElement('div');
    coverDiv.className = 'book-card-cover';

    if (story.coverImageUrl) {
      const img = document.createElement('img');
      img.src = story.coverImageUrl;
      img.alt = '';
      img.loading = 'lazy';
      coverDiv.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'book-card-cover-placeholder';
      placeholder.textContent = CARD_ICONS[index % CARD_ICONS.length];
      coverDiv.appendChild(placeholder);
    }

    card.appendChild(coverDiv);

    // Body
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'book-card-body';

    const title = document.createElement('h3');
    title.className = 'book-card-title';
    title.textContent = story.title;
    bodyDiv.appendChild(title);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'book-card-meta';

    const dateSpan = document.createElement('span');
    dateSpan.textContent = formatDate(story.createdAt);
    metaDiv.appendChild(dateSpan);

    const pagesSpan = document.createElement('span');
    pagesSpan.className = 'book-card-pages';
    pagesSpan.textContent = `${story.pageCount} pages`;
    metaDiv.appendChild(pagesSpan);

    bodyDiv.appendChild(metaDiv);
    card.appendChild(bodyDiv);

    // Stagger entrance animation
    card.style.opacity = '0';
    card.style.transform = 'translateY(16px)';
    card.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    setTimeout(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, index * 80);

    storiesShelf.appendChild(card);
  });
}

async function openStory(storyId) {
  try {
    const response = await fetch(`/api/stories/${encodeURIComponent(storyId)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Could not load story.');
    }

    state.activeStory = payload.story;
    state.currentPage = 0;
    renderReader();
    switchTab('reader');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not load story.');
  }
}

function renderReader() {
  if (!state.activeStory) {
    readerEmpty.hidden = false;
    readerActive.hidden = true;
    return;
  }

  readerEmpty.hidden = true;
  readerActive.hidden = false;

  const story = state.activeStory;
  readerTitle.textContent = story.title;
  readerPrompt.textContent = story.prompt;

  renderPageDots();
  renderCurrentPage();
}

function renderPageDots() {
  while (pageDotsContainer.firstChild) {
    pageDotsContainer.removeChild(pageDotsContainer.firstChild);
  }

  const pages = getSortedPages();

  // Read-aloud button
  const readBtn = document.createElement('button');
  readBtn.className = 'page-dot';
  readBtn.title = 'Read aloud';
  readBtn.textContent = '\u{1F50A}';
  readBtn.style.cssText = 'width:auto;height:auto;padding:2px 8px;border-radius:999px;font-size:0.85rem;margin-right:8px;';
  readBtn.addEventListener('click', () => {
    if (state.reading) {
      stopReading();
    } else {
      readAloud();
    }
  });
  pageDotsContainer.appendChild(readBtn);

  pages.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.className = `page-dot${index === state.currentPage ? ' active' : ''}`;
    dot.setAttribute('aria-label', `Page ${index + 1}`);
    dot.addEventListener('click', () => goToPage(index));
    pageDotsContainer.appendChild(dot);
  });
}

function renderCurrentPage() {
  const pages = getSortedPages();

  if (!pages.length) {
    bookPageImg.src = '';
    bookPageImg.alt = '';
    bookPageNumber.textContent = '';
    bookPageText.textContent = 'This story has no pages.';
    prevPageBtn.disabled = true;
    nextPageBtn.disabled = true;
    return;
  }

  const page = pages[state.currentPage];
  const total = pages.length;
  const num = page.pageNumber || state.currentPage + 1;

  if (page.imageUrl) {
    bookPageImg.src = page.imageUrl;
    bookPageImg.alt = `Illustration for page ${num}`;
    bookPageImg.parentElement.style.display = '';
  } else {
    bookPageImg.src = '';
    bookPageImg.alt = '';
    bookPageImg.parentElement.style.display = 'none';
  }

  bookPageNumber.textContent = `Page ${num} of ${total}`;
  bookPageText.textContent = page.text;

  prevPageBtn.disabled = state.currentPage <= 0;
  nextPageBtn.disabled = state.currentPage >= total - 1;

  // Update dots
  const dots = pageDotsContainer.querySelectorAll('.page-dot:not([title])');
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === state.currentPage);
  });

  // Animate the page
  bookPageDisplay.style.animation = 'none';
  bookPageDisplay.offsetHeight; // trigger reflow
  bookPageDisplay.style.animation = 'pageFlip 0.35s ease';
}

function goToPage(index) {
  const pages = getSortedPages();
  if (index < 0 || index >= pages.length) return;
  state.currentPage = index;
  renderCurrentPage();
}

function getSortedPages() {
  if (!state.activeStory?.pages) return [];
  return [...state.activeStory.pages].sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
}

// ---- Read aloud ----

// Ranked keywords for selecting the best storytelling voice.
// Prefer premium/natural voices, then female voices (warmer for kids' stories).
const PREFERRED_VOICE_PATTERNS = [
  /samantha/i,         // macOS/iOS — natural, warm
  /karen/i,            // macOS — Australian, friendly
  /moira/i,            // macOS — Irish, gentle
  /fiona/i,            // macOS — Scottish
  /google.*female/i,   // Chrome — decent quality
  /google.*us.*english/i,
  /microsoft.*zira/i,  // Windows — natural-ish
  /microsoft.*aria/i,  // Windows 11 neural
  /microsoft.*jenny/i, // Windows 11 neural
];

let cachedVoice = null;

function getBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // If user has picked a voice, always look it up fresh (don't rely on cache)
  if (state.selectedVoiceURI) {
    const picked = voices.find(v => v.voiceURI === state.selectedVoiceURI);
    if (picked) return picked;
  }

  // For auto-detection, use cache to avoid re-scanning
  if (cachedVoice) return cachedVoice;

  // Try each preferred pattern in priority order
  for (const pattern of PREFERRED_VOICE_PATTERNS) {
    const match = voices.find(v => pattern.test(v.name));
    if (match) {
      cachedVoice = match;
      return match;
    }
  }

  // Fallback: pick the first English voice that isn't a novelty/compact voice
  const englishVoices = voices.filter(v =>
    v.lang.startsWith('en') && !/compact|novelty/i.test(v.name)
  );

  const nonDefault = englishVoices.find(v => !v.default);
  cachedVoice = nonDefault || englishVoices[0] || voices[0];
  return cachedVoice;
}

function populateVoicePicker() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;

  // Preserve user selection across dropdown rebuilds
  const savedURI = state.selectedVoiceURI;

  while (voiceSelect.firstChild) voiceSelect.removeChild(voiceSelect.firstChild);

  // Filter to English voices and group them
  const englishVoices = voices.filter(v => v.lang.startsWith('en'));
  const bestVoice = getBestVoice();

  for (const voice of englishVoices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    const label = voice.name.replace(/Microsoft |Google |Apple /i, '');
    option.textContent = label;
    if (voice === bestVoice) option.selected = true;
    voiceSelect.appendChild(option);
  }

  // Restore user selection in case the rebuild interfered
  if (savedURI) {
    state.selectedVoiceURI = savedURI;
    voiceSelect.value = savedURI;
  }
}

// Pre-load voices (some browsers load them asynchronously)
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = null;
    populateVoicePicker();
  };
  // Some browsers fire onvoiceschanged, some don't — try both
  setTimeout(() => populateVoicePicker(), 100);
}

function readAloud() {
  if (!window.speechSynthesis) return;

  stopReading();
  state.reading = true;

  const pages = getSortedPages();
  if (!pages.length) return;

  readPageAloud(state.currentPage, pages);
}

function readPageAloud(pageIndex, pages) {
  if (!state.reading || pageIndex >= pages.length) {
    stopReading();
    return;
  }

  goToPage(pageIndex);

  const utterance = new SpeechSynthesisUtterance(pages[pageIndex].text);

  const voice = getBestVoice();
  if (voice) {
    utterance.voice = voice;
  }

  utterance.rate = 0.9;
  utterance.pitch = 1.05;
  state.readingUtterance = utterance;

  utterance.onend = () => {
    if (state.reading && pageIndex + 1 < pages.length) {
      setTimeout(() => readPageAloud(pageIndex + 1, pages), 800);
    } else {
      stopReading();
    }
  };

  utterance.onerror = () => {
    stopReading();
  };

  window.speechSynthesis.speak(utterance);

  // Update read-aloud button appearance
  const readBtn = pageDotsContainer.querySelector('[title]');
  if (readBtn) {
    readBtn.textContent = '\u23F9';
    readBtn.title = 'Stop reading';
  }
}

function stopReading() {
  state.reading = false;
  state.readingUtterance = null;

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  const readBtn = pageDotsContainer.querySelector('[title]');
  if (readBtn) {
    readBtn.textContent = '\u{1F50A}';
    readBtn.title = 'Read aloud';
  }
}

// ---- Utilities ----
function setStatus(message) {
  statusEl.textContent = message;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = isLoading;
  loadingIndicator.hidden = !isLoading;

  const createHeader = document.querySelector('.create-header');
  if (isLoading) {
    form.hidden = true;
    if (createHeader) createHeader.hidden = true;
  } else {
    form.hidden = false;
    if (createHeader) createHeader.hidden = false;
  }
}

function celebrateSparkles() {
  const colors = ['#FF8C6B', '#6BC5E8', '#FFD166', '#C3A6E0', '#7EDDB5'];

  for (let i = 0; i < 20; i++) {
    const sparkle = document.createElement('div');
    sparkle.className = 'celebration-sparkle';
    sparkle.style.left = `${30 + Math.random() * 40}%`;
    sparkle.style.top = `${20 + Math.random() * 30}%`;
    sparkle.style.background = colors[Math.floor(Math.random() * colors.length)];
    sparkle.style.animationDelay = `${Math.random() * 0.5}s`;
    const size = `${8 + Math.random() * 12}px`;
    sparkle.style.width = size;
    sparkle.style.height = size;
    document.body.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 1200);
  }
}

function escapeHtml(input) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
