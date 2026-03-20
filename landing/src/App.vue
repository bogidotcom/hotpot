<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';

const API_BASE = 'http://localhost:3000';

// ── State ───────────────────────────────────────────────
const stats = ref({
  activeHotspots: 0,
  totalCoverageM2: 0,
  avgSpeed: '–',
  networkTreasuryASX: '0.00',
  asxPriceUsd: 0,
});
const displayHotspots = ref(0);
const displayCoverage = ref(0);
const displayPaid = ref(0);
const displaySpeed = ref('–');
const loaded = ref(false);
let pollInterval = null;

// ── Fetch live stats ────────────────────────────────────
async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json();
    stats.value = data;
  } catch (e) {
    console.warn('Could not reach backend:', e.message);
  }
}

// ── Animated counter ────────────────────────────────────
function animateCounter(target, setter, duration = 2000) {
  const startTime = performance.now();
  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    setter(Math.floor(eased * target));
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Format numbers ──────────────────────────────────────
function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

const formattedHotspots = computed(() => formatNumber(displayHotspots.value));
const formattedCoverage = computed(() => formatNumber(displayCoverage.value));

// ── Lifecycle ───────────────────────────────────────────
onMounted(async () => {
  await fetchStats();
  loaded.value = true;
  animateCounter(stats.value.activeHotspots, v => (displayHotspots.value = v));
  animateCounter(stats.value.totalCoverageM2, v => (displayCoverage.value = v));
  animateCounter(
    parseFloat(stats.value.networkTreasuryASX),
    v => (displayPaid.value = v),
    3000
  );
  displaySpeed.value = stats.value.avgSpeed;
  pollInterval = setInterval(async () => {
    await fetchStats();
    displaySpeed.value = stats.value.avgSpeed;
    const currentASX = parseFloat(stats.value.networkTreasuryASX);
    if (currentASX > displayPaid.value) {
      animateCounter(currentASX, v => (displayPaid.value = v), 1000);
    }
  }, 15000);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});
</script>

<template>
  <div class="landing">
    <!-- ── Header ── -->
    <header class="header glass">
      <div class="container header-inner">
        <div class="logo">
          <img src="/logo round.png" alt="" class="btn-icon" />
          <span class="logo-text">HOTPOT</span>
        </div>
        <nav class="nav">
          <a href="#radius" class="nav-link">Coverage</a>
          <a href="#pay" class="nav-link">Pricing</a>
          <a href="#earn" class="nav-link">Earn</a>
          <a href="https://blog.assetux.com/?modal=subscribe" target="_blank" class="nav-cta">
            Join Waitlist
          </a>
        </nav>
      </div>
    </header>

    <!-- ── Section 1: Hero (Video) ── -->
    <section class="section hero">
      <video class="bg-video" autoplay muted loop playsinline>
        <source src="/hotpot-bg.mp4" type="video/mp4" />
      </video>
      <div class="bg-overlay"></div>

      <div class="container hero-inner">
        <div class="hero-content animate-in">
          <h1 class="hero-title">
            ONE POT <br />
            <span class="gradient-text">ENDLESS SOUP</span>
          </h1>
          <p class="hero-subtitle">
            The community network where everyone brings a connection to the
            table. Dip into thousands of hotspots across the cyberpunk city.
          </p>
          <div class="hero-actions">
            <a href="https://blog.assetux.com/?modal=subscribe" class="btn-download android">
              <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M17.523 15.3414C17.0673 15.3414 16.6909 14.9651 16.6909 14.5093C16.6909 14.0536 17.0673 13.6773 17.523 13.6773C17.9787 13.6773 18.355 14.0536 18.355 14.5093C18.355 14.9651 17.9787 15.3414 17.523 15.3414ZM6.47702 15.3414C6.01211 15.3414 5.64502 14.9744 5.64502 14.5093C5.64502 14.0445 6.01211 13.6773 6.47702 13.6773C6.94193 13.6773 7.30902 14.0445 7.30902 14.5093C7.30902 14.9744 6.94193 15.3414 6.47702 15.3414ZM17.886 10.4631L19.313 7.99131C19.4141 7.81648 19.3541 7.59296 19.1793 7.49187C19.0044 7.39078 18.7809 7.45071 18.6798 7.62554L17.235 10.1287C15.7196 9.43859 13.9314 9.04944 11.9997 9.04944C10.068 9.04944 8.27976 9.43859 6.76435 10.1287L5.31952 7.62554C5.21843 7.45071 4.99491 7.39078 4.82008 7.49187C4.64525 7.59296 4.58532 7.81648 4.68641 7.99131L6.11335 10.4631C3.15173 12.1092 1.11475 14.9602 1.00415 18.3553H22.9959C22.8853 14.9602 20.8483 12.1092 17.886 10.4631Z"
                />
              </svg>
              <span>Join Waitlist</span>
            </a>
            <a
              href="https://cyreneai.com/projects/hotpot"
              target="_blank"
              class="btn-download ios"
            >
              <img class="btn-icon" src="/logo round.png" alt="" />
              <!-- <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.057 12.781c.018 2.394 2.1 3.19 2.133 3.203-.021.053-.33 1.127-1.085 2.227-.655.942-1.332 1.879-2.387 1.897-1.037.017-1.371-.617-2.559-.617-1.189 0-1.56.6-2.54.636-1.038.035-1.808-.99-2.469-1.944-1.353-1.954-2.388-5.523-1.004-7.923.687-1.192 1.916-1.948 3.242-1.967 1.004-.015 1.954.678 2.564.678.608 0 1.77-.852 2.981-.73 1.211.122 2.128.563 2.723 1.424-.051.04-.378.225-.76.442zM14.96 5.86c.548-.663.918-1.583.817-2.502-.857.034-1.896.574-2.508 1.288-.549.638-.857 1.583-.757 2.478.857.035 1.896-.516 2.448-1.264z"/>
              </svg> -->
              <span>Buy HOTPOT</span>
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Section 2: WiFi Radius (Mesh) ── -->
    <section id="radius" class="section radius-section">
      <!-- <div class="bg-image" style="background-image: url('/connection.mp4');"></div> -->
      <video class="bg-video" autoplay muted loop playsinline>
        <source src="/connection.mp4" type="video/mp4" />
      </video>
      <div class="bg-overlay"></div>

      <div class="container content-center">
        <h2 class="section-title">
          The <span class="gradient-text">Spice Radius</span>
        </h2>
        <p class="section-desc">
          We don't rely on central towers. Our network is a living mesh of
          people. Every connection intersects, creating an unbreakable web of
          data. When you walk, you're not just connecting — you're building the
          grid.
        </p>

        <!-- <div class="stat-row glass">
          <div class="stat-item">
            <div class="stat-val">{{ formattedCoverage }} m²</div>
            <div class="stat-lbl">AREA</div>
          </div>
          <div class="stat-item">
            <div class="stat-val">${{ asx_price }}</div>
            <div class="stat-lbl">ASX PRICE</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat-item">
            <div class="stat-val">{{ formattedHotspots }}</div>
            <div class="stat-lbl">Hotpots</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat-item">
            <div class="stat-val">{{ displaySpeed }}</div>
            <div class="stat-lbl">Bandwidth</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat-item">
            <div class="stat-val">{{ displayPaid.toFixed(0) }} ASX</div>
            <div class="stat-lbl">Treasury</div>
          </div>
        </div> -->
      </div>
    </section>

    <!-- ── Section 3: Pay As You Go ── -->
    <section id="pay" class="section pay-section">
      <!-- <div class="bg-image" style="background-image: url('/pay.mp4');"></div> -->
      <video class="bg-video" autoplay muted loop playsinline>
        <source src="/pay.mp4" type="video/mp4" />
      </video>
      <div class="bg-overlay-dark"></div>

      <div class="container content-left">
        <h2 class="section-title">
          Pay Only For <span class="gradient-text-green">What You Eat</span>
        </h2>
        <p class="section-desc">
          No monthly subscriptions. No wasted data. 1 GB = $0.10 paid in ASX —
          deducted instantly, only for what you consume. 10% is burned, keeping
          the token deflationary.
        </p>
        <a
          href="https://cyreneai.com/projects/hotpot"
          target="_blank"
          class="feature-badge glass"
        >
          <span class="icon">⚡</span> Instant Settlement
        </a>
      </div>
    </section>

    <!-- ── Section 4: Earn USDC ── -->
    <section id="earn" class="section earn-section">
      <!-- <div class="bg-image" style="background-image: url('/earn-usdc.png');"></div> -->
      <video class="bg-video" autoplay muted loop playsinline>
        <source src="/earn.mp4" type="video/mp4" />
      </video>
      <div class="bg-overlay-dark"></div>

      <div class="container content-right">
        <h2 class="section-title">
          Get Paid to <span class="gradient-text-gold">Host the Pot</span>
        </h2>
        <p class="section-desc">
          Got bandwidth? Use it. Earn HOTPOT as others connect through your
          hotspot — whatever is tipped. Claim directly to your Solana wallet, no
          middleman.
        </p>
        <a href="https://blog.assetux.com/?modal=subscribe" class="feature-badge glass">
          Start Earning
        </a>
      </div>
    </section>

    <!-- ── Footer ── -->
    <footer class="footer">
      <div class="container footer-grid">
        <div class="footer-col brand">
          <div class="logo">
            <div class="logo-icon">🍲</div>
            <span class="logo-text">HOTPOT</span>
          </div>
          <p class="footer-tagline">
            Serving hot data since 2026. The world's first decentralized mesh
            network powered by the community.
          </p>
          <!-- <div class="footer-socials">
            <a href="#" class="social-link" title="Twitter">𝕏</a>
            <a href="#" class="social-link" title="Discord">👾</a>
            <a href="#" class="social-link" title="Telegram">✈️</a>
          </div> -->
        </div>

        <!-- <div class="footer-col">
          <h4 class="footer-title">Network</h4>
          <ul class="footer-list">
            <li><a href="#radius" class="footer-link">Coverage Map</a></li>
            <li><a href="#pay" class="footer-link">Pricing Model</a></li>
            <li><a href="#earn" class="footer-link">Host Program</a></li>
            <li><a href="#" class="footer-link">Speed Test</a></li>
          </ul>
        </div> -->

        <div class="footer-col">
          <h4 class="footer-title">Resources</h4>
          <ul class="footer-list">
            <li>
              <a
                href="https://x.com/hotpot_net"
                target="_blank"
                class="footer-link"
                >X</a
              >
            </li>
            <li>
              <a
                href="https://hotpot.assetux.com"
                target="_blank"
                class="footer-link"
                >Website</a
              >
            </li>
            <li>
              <a
                href="https://cyreneai.com/projects/hotpot"
                target="_blank"
                class="footer-link"
                >HOTPOT</a
              >
            </li>
            <li>
              <a
                href="https://cyreneai.com/projects/assetux"
                target="_blank"
                class="footer-link"
                >ASX</a
              >
            </li>
          </ul>
        </div>

        <div class="footer-col status-col">
          <h4 class="footer-title">Status</h4>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span class="status-text">Network Optimal</span>
          </div>
          <!-- <p class="status-info">Global latency: 12ms</p>
          <p class="status-info">Active nodes: {{ formattedHotspots }}</p> -->
        </div>
      </div>

      <div class="container footer-bottom">
        <div class="footer-bottom-inner">
          <div class="footer-copy">© 2026 Hotpot Network. By Assetux</div>
          <div class="footer-legal">
            <a
              href="https://assetux.gitbook.io/assetux/legal/terms-of-use"
              target="_blank"
              class="footer-link-sm"
              >Kitchen Rules</a
            >
            <!-- <a href="/privacy" class="footer-link-sm">Secret Sauce</a> -->
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ── Layout ──────────────────────────────────────────── */
.container {
  max-width: var(--container-max);
  margin: 0 auto;
  padding: 0 24px;
}

.section {
  position: relative;
  width: 100%;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.bg-image,
.bg-video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: -2;
}

.bg-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(5, 5, 5, 0.3),
    rgba(5, 5, 5, 0.8)
  );
  z-index: -1;
}

.bg-overlay-dark {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: -1;
}

/* ── Header ──────────────────────────────────────────── */
.header {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 1000;
  padding: 16px 0;
  transition: all 0.3s ease;
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: 'Orbitron', sans-serif;
  font-weight: 800;
  font-size: 1.5rem;
}

.logo-icon {
  font-size: 1.8rem;
  filter: drop-shadow(0 0 10px var(--accent-primary));
}

.nav {
  display: flex;
  align-items: center;
  gap: 32px;
}

.nav-link {
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: color 0.3s ease;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.nav-link:hover {
  color: var(--accent-primary);
}

.nav-cta {
  padding: 10px 20px;
  background: var(--accent-primary);
  color: white;
  border-radius: var(--radius-sm);
  font-weight: 700;
  text-transform: uppercase;
  font-size: 0.85rem;
  letter-spacing: 0.05em;
  transition: all 0.3s ease;
  box-shadow: var(--shadow-button);
}

.nav-cta:hover {
  background: var(--accent-primary-light);
  transform: translateY(-2px);
  box-shadow: 0 0 30px var(--accent-glow);
}

/* ── Typography & Content ────────────────────────────── */
.section-title {
  font-size: clamp(3rem, 5vw, 4.5rem);
  font-weight: 900;
  margin-bottom: 24px;
  line-height: 1.1;
  text-shadow: 0 4px 20px rgba(0, 0, 0, 0.8);
}

.section-desc {
  font-size: 1.25rem;
  line-height: 1.6;
  max-width: 600px;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.8);
  margin-bottom: 32px;
}

.content-center {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.content-left {
  text-align: left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  width: 100%;
}
.content-right {
  text-align: right;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
}

/* ── Hero Specifics ──────────────────────────────────── */
.hero-content {
  max-width: 800px;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: 100px;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 24px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.badge-dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  box-shadow: 0 0 10px var(--accent-primary);
  animation: pulse-glow 2s infinite;
}

.hero-title {
  font-size: clamp(3.5rem, 6vw, 5.5rem);
  text-shadow: 0 0 20px rgba(0, 0, 0, 0.8);
  margin-bottom: 24px;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 40px;
}

.btn-download {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  color: white;
  font-weight: 600;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
}

.btn-download:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--accent-primary);
  transform: translateY(-2px);
  box-shadow: 0 0 20px var(--accent-glow);
}

.btn-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

/* ── Buttons ─────────────────────────────────────────── */
.btn-primary,
.btn-secondary {
  padding: 16px 32px;
  border-radius: var(--radius-sm);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-primary {
  background: var(--accent-primary);
  color: white;
  box-shadow: var(--shadow-button);
}

.btn-primary:hover {
  background: var(--accent-primary-light);
  transform: translateY(-3px);
  box-shadow: 0 0 40px var(--accent-glow);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.05);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-3px);
  border-color: rgba(255, 255, 255, 0.2);
}

/* ── Specific Styles ─────────────────────────────────── */
.gradient-text-green {
  background: linear-gradient(135deg, #06d6a0 0%, #2ec4b6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 15px rgba(6, 214, 160, 0.4));
}

.gradient-text-gold {
  background: linear-gradient(135deg, #ffd700 0%, #ffbf00 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 0 15px rgba(255, 215, 0, 0.4));
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 40px;
  padding: 20px 40px;
  border-radius: var(--radius-md);
  margin-top: 20px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
}

.stat-val {
  font-family: 'Orbitron', monospace;
  font-size: 2rem;
  font-weight: 800;
}

.stat-lbl {
  font-size: 0.8rem;
  text-transform: uppercase;
  color: var(--text-secondary);
  letter-spacing: 0.1em;
}

.stat-sep {
  width: 1px;
  height: 40px;
  background: rgba(255, 255, 255, 0.2);
}

.feature-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 24px;
  border-radius: 100px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: rgba(6, 214, 160, 0.15);
  border: 1px solid #06d6a0;
  color: #06d6a0;
}

.footer {
  background: linear-gradient(to bottom, #0a0000, #050505);
  border-top: 1px solid var(--border-subtle);
  padding: 100px 0 40px;
  position: relative;
  z-index: 10;
}

.footer-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1.5fr;
  gap: 60px;
  margin-bottom: 80px;
}

.footer-col.brand {
  max-width: 320px;
}

.footer-tagline {
  margin-top: 20px;
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1.6;
}

.footer-socials {
  display: flex;
  gap: 16px;
  margin-top: 28px;
}

.social-link {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  color: var(--text-primary);
  font-size: 1.1rem;
  transition: all 0.3s ease;
}

.social-link:hover {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  transform: translateY(-3px);
  box-shadow: 0 0 15px var(--accent-glow);
}

.footer-title {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 24px;
  color: white;
  letter-spacing: 0.1em;
}

.footer-list {
  list-style: none;
  padding: 0;
}

.footer-list li {
  margin-bottom: 12px;
}

.footer-link {
  color: var(--text-secondary);
  transition: color 0.3s ease;
  font-size: 0.95rem;
}

.footer-link:hover {
  color: var(--accent-primary);
  padding-left: 4px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(6, 214, 160, 0.1);
  border: 1px solid rgba(6, 214, 160, 0.2);
  padding: 8px 16px;
  border-radius: 100px;
  width: fit-content;
  margin-bottom: 16px;
}

.status-dot {
  width: 8px;
  height: 8px;
  background: #06d6a0;
  border-radius: 50%;
  box-shadow: 0 0 10px #06d6a0;
  animation: pulse-glow 2s infinite;
}

.status-text {
  color: #06d6a0;
  font-size: 0.85rem;
  font-weight: 700;
  text-transform: uppercase;
}

.status-info {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.footer-bottom {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 40px;
}

.footer-bottom-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.footer-copy {
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

.footer-legal {
  display: flex;
  gap: 24px;
}

.footer-link-sm {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  transition: color 0.3s ease;
}

.footer-link-sm:hover {
  color: var(--text-secondary);
}

@media (max-width: 1024px) {
  .footer-grid {
    grid-template-columns: 1fr 1fr;
    gap: 40px;
  }
}

@media (max-width: 768px) {
  .section {
    padding: 80px 20px;
    text-align: center;
  }
  .content-left,
  .content-right {
    align-items: center;
    text-align: center;
  }
  .hero-title {
    font-size: 2.8rem;
  }
  .section-title {
    font-size: 2.5rem;
  }
  .hero-actions {
    flex-direction: column;
    width: 100%;
  }
  .btn-primary,
  .btn-secondary {
    width: 100%;
  }
  .nav {
    display: none;
  }

  .footer-grid {
    grid-template-columns: 1fr;
    text-align: center;
    gap: 40px;
  }

  .footer-col.brand {
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .status-indicator {
    margin: 0 auto 16px;
  }

  .footer-bottom-inner {
    flex-direction: column;
    gap: 20px;
  }
}
</style>
