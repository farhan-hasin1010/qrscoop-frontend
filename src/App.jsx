/**
 * QRScoop — React frontend
 *
 * SECURITY / CORRECTNESS FIXES APPLIED:
 *  1. Replaced userId localStorage pattern with a single `session` state.
 *     userId is now derived as session?.user?.id — never stored separately.
 *  2. All authenticated API calls now send Authorization: Bearer <token>
 *     from the live Supabase session, NOT a body-level userId parameter.
 *  3. alert() replaced throughout with an in-app toast notification system.
 *  4. handleLogout: removed wrong localStorage key ('supabase.auth.token'
 *     does not exist in Supabase v2); signOut() handles its own cleanup.
 *  5. onAuthStateChange: INITIAL_SESSION (page reload) no longer triggers
 *     view navigation or profile writes. Only SIGNED_IN (fresh login) does.
 *  6. Google OAuth backup geolocation URL fixed from http:// → https://.
 *  7. Dead state removed: userSession, profileData.
 *  8. handleGenerateQr: body no longer contains userId.
 *  9. openRazorpay / payment verify: body no longer contains userId.
 * 10. Premium status fetch: now includes Authorization header.
 * 11. Dashboard modal: static QR codes correctly encode target_url directly
 *     (not the redirect URL) for all content types.
 * 12. All debug console.log and commented-out alert removed.
 *
 * NEW:
 *  - Static QR tab in the generator (no server redirect, no expiry,
 *    available to all users including guests).
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import QRCodeStyling from 'qr-code-styling';
import { supabase } from './supabaseClient.js';

import Papa from 'papaparse';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';



// ── QR Design Constants ──────────────────────────────────────────────────────
const DOT_STYLES = [
  { id: 'square', label: 'Square', svg: 'M2 2h12v12H2z' },
  { id: 'dots', label: 'Dots', svg: 'M8 2a6 6 0 100 12A6 6 0 008 2z' },
  { id: 'rounded', label: 'Rounded', svg: 'M4 2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z' },
  { id: 'extra-rounded', label: 'Extra Round', svg: 'M8 1a7 7 0 100 14A7 7 0 008 1z' },
  { id: 'classy', label: 'Classy', svg: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z' },
  { id: 'classy-rounded', label: 'Classy+', svg: 'M3 2h4a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zM10 2h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V3a1 1 0 011-1zM3 10h4a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1v-4a1 1 0 011-1z' },
];

const CORNER_STYLES = [
  { id: 'square', label: 'Square' },
  { id: 'extra-rounded', label: 'Rounded' },
  { id: 'dot', label: 'Dot' },
];

const ERROR_LEVELS = [
  { id: 'L', label: 'Low', pct: '7%', desc: 'Smallest QR', rec: false },
  { id: 'M', label: 'Medium', pct: '15%', desc: 'Balanced', rec: false },
  { id: 'Q', label: 'Quartile', pct: '25%', desc: 'Good for logos', rec: true },
  { id: 'H', label: 'High', pct: '30%', desc: 'Best with logo', rec: false },
];

const PALETTE = [
  '#000000', '#1d4ed8', '#7c3aed', '#db2777', '#dc2626',
  '#ea580c', '#16a34a', '#0891b2', '#4a5568', '#92400e',
];

const GRADIENT_PRESETS = [
  { label: 'Ocean', from: '#0891b2', to: '#1d4ed8' },
  { label: 'Violet', from: '#7c3aed', to: '#db2777' },
  { label: 'Ember', from: '#ea580c', to: '#dc2626' },
  { label: 'Forest', from: '#16a34a', to: '#0891b2' },
  { label: 'Mono', from: '#000000', to: '#4a5568' },
];

// ── Helper: build QR options object ─────────────────────────────────────────
function buildQrOptions({ data, dotStyle, dotColor, useGradient, gradFrom, gradTo,
  bgColor, bgTransparent, cornerStyle, cornerColor, errorLevel, size, logoDataUrl }) {
  return {
    width: size, height: size,
    type: 'canvas',
    data: data || 'https://qrscoop.app',
    image: logoDataUrl || undefined,
    qrOptions: { errorCorrectionLevel: errorLevel },
    imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35 },
    dotsOptions: useGradient
      ? {
        type: dotStyle,
        gradient: {
          type: 'linear', rotation: 45,
          colorStops: [{ offset: 0, color: gradFrom }, { offset: 1, color: gradTo }],
        },
      }
      : { type: dotStyle, color: dotColor },
    backgroundOptions: bgTransparent ? { color: 'transparent' } : { color: bgColor },
    cornersSquareOptions: { type: cornerStyle, color: cornerColor },
    cornersDotOptions: { type: cornerStyle === 'dot' ? 'dot' : 'square', color: cornerColor },
  };
}

// ── URL validation helper ────────────────────────────────────────────────────
const isValidHttpUrl = (str) => {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const slugify = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')        // Replace spaces with -
    .replace(/[^\w\-]+/g, '')    // Remove all non-word chars
    .replace(/\-\-+/g, '-')      // Replace multiple - with single -
    .replace(/^-+/, '')          // Trim - from start of text
    .replace(/-+$/, '');         // Trim - from end of text

const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;



// ════════════════════════════════════════════════════════════════════════════
export default function App() {

  // ── Routing ───────────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const location = useLocation();

  const ROUTE_MAP = {
    landing: '/',
    app: '/generate',
    bulk: '/bulk',
    howto: '/how-to-use',
    marketing: '/for-business',
    guide: '/qr-guide',
    pricing: '/pricing',
    dashboard: '/dashboard',
    login: '/login',
    tos: '/terms',
    privacy: '/privacy',
    refund: '/refund',
    contact: '/contact',
  };

  // Check if current URL is a custom landing page
  const isLandingPageRoute = location.pathname.startsWith('/p/');
  const landingSlug = isLandingPageRoute
    ? location.pathname.replace('/p/', '').trim().toLowerCase()
    : null;

  const view = isLandingPageRoute
    ? 'public-landing'
    : Object.keys(ROUTE_MAP).find((k) => ROUTE_MAP[k] === location.pathname) || 'landing';

  const [menuOpen, setMenuOpen] = useState(false);

  // ── Auth & Profile ────────────────────────────────────────────────────────
  // FIX: single source of truth — derive userId from session, never localStorage
  const [session, setSession] = useState(null);
  const [isSignUp, setIsSignUp] = useState(false);
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });
  const [authLoading, setAuthLoading] = useState(false);
  const [isPremium, setIsPremium] = useState(false);
  const [premiumUntil, setPremiumUntil] = useState(null); // Add this line
  const [userProfile, setUserProfile] = useState({ name: '', email: '', avatar: '', location: '' });

  // Derived — never stored separately in state
  const userId = session?.user?.id || null;

  // ── Toast notification system (replaces all alert() calls) ───────────────
  const [toasts, setToasts] = useState([]);
  const showToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  };

  // ── QR Content ────────────────────────────────────────────────────────────
  const [qrMode, setQrMode] = useState('dynamic'); // 'dynamic' | 'static'
  const [contentType, setContentType] = useState('link');
  const [payloadUrl, setPayloadUrl] = useState('');
  const [wifiName, setWifiName] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [wifiSecurity, setWifiSecurity] = useState('WPA');
  const [rawText, setRawText] = useState('');
  const [vcard, setVcard] = useState({ name: '', phone: '', email: '' });
  const [upi, setUpi] = useState({ vpa: '', name: '', amount: '', note: '' });

  // ── Bulk CSV Generator State ──────────────────────────────────────────────
  const [csvData, setCsvData]           = useState([]);
  const [csvFileName, setCsvFileName]   = useState('');
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);

  // ── Public Landing Page State ─────────────────────────────────────────────
  const [landingData, setLandingData]         = useState(null);
  const [landingLoading, setLandingLoading]   = useState(false);
  const [landingError, setLandingError]       = useState(null);

  // ── Dashboard Landing Pages Manager State ─────────────────────────────────
  const [userLandingPages, setUserLandingPages]       = useState([]);
  const [showLandingModal, setShowLandingModal]       = useState(false);
  const [landingModalLoading, setLandingModalLoading] = useState(false);
  const [landingForm, setLandingForm]                 = useState({
    id: null,
    slug: '',
    title: '',
    bio: '',
    avatar_url: '',
    links: [{ id: Date.now(), title: '', url: '' }],
  });

  // ── QR Design ─────────────────────────────────────────────────────────────
  const [designTab, setDesignTab] = useState('content');
  const [dotStyle, setDotStyle] = useState('rounded');
  const [dotColor, setDotColor] = useState('#1d4ed8');
  const [useGradient, setUseGradient] = useState(false);
  const [gradFrom, setGradFrom] = useState('#0891b2');
  const [gradTo, setGradTo] = useState('#7c3aed');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [bgTransparent, setBgTransparent] = useState(false);
  const [cornerStyle, setCornerStyle] = useState('extra-rounded');
  const [cornerColor, setCornerColor] = useState('#1d4ed8');
  const [syncCorner, setSyncCorner] = useState(true);
  const [errorLevel, setErrorLevel] = useState('Q');
  const [qrSize, setQrSize] = useState(300);
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [logoName, setLogoName] = useState('');

  // ── QR Result ─────────────────────────────────────────────────────────────
  const [activeShortCode, setActiveShortCode] = useState('');
  const [showResult, setShowResult] = useState(false);
  const [showPremiumGate, setShowPremiumGate] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const [dashData, setDashData] = useState([]);
  const [dashLoading, setDashLoading] = useState(false);
  const [viewQr, setViewQr] = useState(null);

  

  // ── QR Code instances ──────────────────────────────────────────────────────
  const qrInstanceRef = useRef(null);
  const qrContainerRef = useRef(null);
  const modalQrRef = useRef(null);
  const modalCanvasRef = useRef(null);

  // ── Derived payload ───────────────────────────────────────────────────────
  const escapeWifi = (str) => String(str).replace(/([;,:"\\])/g, '\\$1');

  const getPayload = () => {
    if (contentType === 'link') return payloadUrl.trim();
    if (contentType === 'wifi') {
      const ssid = escapeWifi(wifiName);
      const pass = wifiSecurity === 'nopass' ? '' : escapeWifi(wifiPass);
      return `WIFI:T:${wifiSecurity};S:${ssid};P:${pass};H:false;;`;
    }
    if (contentType === 'text') return rawText.trim();
    if (contentType === 'vcard') return `BEGIN:VCARD\nVERSION:3.0\nN:${vcard.name}\nTEL:${vcard.phone}\nEMAIL:${vcard.email}\nEND:VCARD`;

    // UPI payload standard
    if (contentType === 'upi') {
      const vpa = upi.vpa.trim();
      const name = upi.name.trim();
      if (!vpa || !name) return '';
      const params = new URLSearchParams();
      params.append('pa', vpa);
      params.append('pn', name);
      if (upi.amount && parseFloat(upi.amount) > 0) {
        params.append('am', parseFloat(upi.amount).toFixed(2));
      }
      params.append('cu', 'INR');
      if (upi.note.trim()) {
        params.append('tn', upi.note.trim());
      }
      return `upi://pay?${params.toString()}`;
    }
    return '';
  };

  const currentQrOpts = () => buildQrOptions({
    data: getPayload() || 'https://qrscoop.app',
    dotStyle, dotColor, useGradient, gradFrom, gradTo,
    bgColor, bgTransparent, cornerStyle,
    cornerColor: syncCorner ? dotColor : cornerColor,
    errorLevel, size: qrSize, logoDataUrl,
  });

  // ── Init QR instance ──────────────────────────────────────────────────────
  useEffect(() => {
    qrInstanceRef.current = new QRCodeStyling(currentQrOpts());
  }, []); // eslint-disable-line

  // ── Attach / reattach when app view mounts ─────────────────────────────────
  useEffect(() => {
    if (view === 'app' && qrContainerRef.current && qrInstanceRef.current) {
      qrContainerRef.current.innerHTML = '';
      qrInstanceRef.current.append(qrContainerRef.current);
    }
  }, [view]);

  // ── Live update QR preview ────────────────────────────────────────────────
  const lastEncodedDataRef = useRef(null);

  useEffect(() => {
    if (!qrInstanceRef.current) return;
    const opts = currentQrOpts();
    if (showResult && lastEncodedDataRef.current) {
      opts.data = lastEncodedDataRef.current;
    }
    qrInstanceRef.current.update(opts);
  }, [
    dotStyle, dotColor, useGradient, gradFrom, gradTo,
    bgColor, bgTransparent, cornerStyle, cornerColor, syncCorner,
    errorLevel, qrSize, logoDataUrl,
    payloadUrl, wifiName, wifiPass, wifiSecurity, rawText, vcard, upi, // <-- Added upi
    showResult,
  ]);

  // ── Auth state listener ───────────────────────────────────────────────────
  // FIX: INITIAL_SESSION (page reload with existing session) no longer
  //      triggers view navigation or profile writes. Only SIGNED_IN does.
  useEffect(() => {
    // Restore existing session on page load
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);

      if (event === 'SIGNED_IN' && s) {
        // Only run on fresh logins — not on page reload (INITIAL_SESSION)
        const localSavedLocation = localStorage.getItem('pending_signup_location');
        if (localSavedLocation) {
          const googleAvatar = s.user?.user_metadata?.avatar_url || '';
          await supabase.from('profiles').upsert({
            user_id: s.user.id,
            location: localSavedLocation,
            avatar_url: googleAvatar,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
          localStorage.removeItem('pending_signup_location');
        }
        nav('app');
      }

      if (event === 'SIGNED_OUT') {
        nav('landing');
        setDashData([]);
        setIsPremium(false);
        setUserProfile({ name: '', email: '', avatar: '', location: '' });
      }
    });

    return () => authListener.subscription.unsubscribe();
  }, []);

  // ── Fetch user profile & premium status when session changes ──────────────
  useEffect(() => {
    if (!session?.user) return;

    const fetchUserData = async () => {
      try {
        const { user } = session;
        // Pull profile from Supabase profiles table (has location + avatar)
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('location, avatar_url')
          .eq('user_id', user.id)
          .single();

        setUserProfile({
          name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User',
          email: user.email || '',
          avatar: profileRow?.avatar_url || user.user_metadata?.avatar_url || '',
          location: profileRow?.location || '',
        });

        // Premium status — auth-gated endpoint with Bearer token
        const res = await fetch(`${BACKEND_URL}/api/user/${user.id}/status`, {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        });
        const d = await res.json();
        setIsPremium(d.isPremium || false);
        setPremiumUntil(d.premiumUntil || null); // Add this line
      } catch (err) {
        console.error('Failed to load user profile:', err);
      }
    };

    fetchUserData();
  }, [session]);

  // ── Dashboard fetch ───────────────────────────────────────────────────────
  useEffect(() => {
    if (view === 'dashboard' && userId && session) {
      setDashLoading(true);
      fetch(`${BACKEND_URL}/api/user/${userId}/dashboard`, {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
        .then(r => r.json())
        .then(d => { if (d.success) setDashData(d.qrCodes); })
        .catch(() => { })
        .finally(() => setDashLoading(false));
    }
  }, [view, userId, session]);

  // ── Render QR in dashboard preview modal ──────────────────────────────────
  useEffect(() => {
    if (!viewQr) return;

    // FIX: static QRs always encode target_url directly (never the redirect URL)
    const encodedData = (viewQr.qr_type === 'dynamic' && viewQr.content_type === 'link')
      ? `${BACKEND_URL}/r/${viewQr.short_code}`
      : viewQr.target_url;

    if (modalQrRef.current) modalQrRef.current = null;

    const timer = setTimeout(() => {
      if (!modalCanvasRef.current) return;
      modalCanvasRef.current.innerHTML = '';
      modalQrRef.current = new QRCodeStyling({
        width: 260, height: 260,
        type: 'canvas',
        data: encodedData,
        dotsOptions: { type: 'rounded', color: '#1d4ed8' },
        cornersSquareOptions: { type: 'extra-rounded', color: '#1d4ed8' },
        cornersDotOptions: { type: 'square', color: '#1d4ed8' },
        backgroundOptions: { color: '#ffffff' },
        qrOptions: { errorCorrectionLevel: 'Q' },
      });
      modalQrRef.current.append(modalCanvasRef.current);
    }, 60);

    return () => clearTimeout(timer);
  }, [viewQr]);

  // 1. Fetch public landing page when someone visits /p/:slug
  useEffect(() => {
    if (view !== 'public-landing' || !landingSlug) return;

    const fetchLandingPage = async () => {
      setLandingLoading(true);
      setLandingError(null);
      try {
        const { data, error } = await supabase
          .from('landing_pages')
          .select('*')
          .eq('slug', landingSlug)
          .single();

        if (error || !data) throw new Error('Page not found');
        setLandingData(data);
      } catch (err) {
        setLandingError('This custom landing page does not exist or has been removed.');
      } finally {
        setLandingLoading(false);
      }
    };

    fetchLandingPage();
  }, [view, landingSlug]);

  // 2. Fetch all landing pages owned by the logged-in user for Dashboard
  const fetchUserLandingPages = async () => {
    if (!userId) return;
    try {
      const { data, error } = await supabase
        .from('landing_pages')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (!error && data) setUserLandingPages(data);
    } catch (err) {
      console.error('Failed to fetch user landing pages:', err);
    }
  };

  useEffect(() => {
    if (view === 'dashboard' && userId && session) {
      fetchUserLandingPages();
    }
  }, [view, userId, session]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleOpenLandingModal = (page = null) => {
    if (page) {
      setLandingForm({
        id: page.id,
        slug: page.slug,
        title: page.title,
        bio: page.bio || '',
        avatar_url: page.avatar_url || '',
        links: Array.isArray(page.links) && page.links.length > 0
          ? page.links
          : [{ id: Date.now(), title: '', url: '' }],
      });
    } else {
      setLandingForm({
        id: null,
        slug: '',
        title: '',
        bio: '',
        avatar_url: '',
        links: [{ id: Date.now(), title: '', url: '' }],
      });
    }
    setShowLandingModal(true);
  };

  const handleAddLinkRow = () => {
    // Free tier restriction: 1 link maximum
    if (!isPremium && landingForm.links.length >= 1) {
      showToast('Free tier includes 1 link. Upgrade to Pro for unlimited links & embeds! 👑', 'info');
      setShowPremiumGate(true);
      return;
    }

    setLandingForm(prev => ({
      ...prev,
      links: [...prev.links, { id: Date.now(), title: '', url: '' }],
    }));
  };

  const handleRemoveLinkRow = (id) => {
    setLandingForm(prev => ({
      ...prev,
      links: prev.links.filter(l => l.id !== id),
    }));
  };

  const handleUpdateLinkRow = (id, field, value) => {
    setLandingForm(prev => ({
      ...prev,
      links: prev.links.map(l => (l.id === id ? { ...l, [field]: value } : l)),
    }));
  };

  const handleSaveLandingPage = async (e) => {
    e.preventDefault();
    if (!session || !userId) { nav('login'); return; }

    const cleanSlug = landingForm.slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanSlug) {
      showToast('Please provide a valid slug (letters, numbers, dashes).', 'error');
      return;
    }
    if (!landingForm.title.trim()) {
      showToast('Page title is required.', 'error');
      return;
    }

    let sanitizedLinks = landingForm.links
      .filter(l => l.title.trim() && l.url.trim())
      .map(l => ({
        id: l.id,
        title: l.title.trim(),
        url: l.url.trim().startsWith('http') ? l.url.trim() : `https://${l.url.trim()}`,
      }));

    // If user is not Pro, strictly allow only 1 link
    if (!isPremium && sanitizedLinks.length > 1) {
      sanitizedLinks = sanitizedLinks.slice(0, 1);
    }

    setLandingModalLoading(true);
    try {
      const payload = {
        user_id: userId,
        slug: cleanSlug,
        title: landingForm.title.trim(),
        bio: landingForm.bio.trim(),
        avatar_url: landingForm.avatar_url.trim(),
        links: sanitizedLinks,
        updated_at: new Date().toISOString(),
      };

      if (landingForm.id) {
        const { error } = await supabase
          .from('landing_pages')
          .update(payload)
          .eq('id', landingForm.id)
          .eq('user_id', userId);
        if (error) throw error;
        showToast('Landing page updated successfully!', 'success');
      } else {
        const { error } = await supabase
          .from('landing_pages')
          .insert([payload]);
        if (error) {
          if (error.code === '23505') {
            showToast('Slug is already taken! Please choose another URL slug.', 'error');
            setLandingModalLoading(false);
            return;
          }
          throw error;
        }
        showToast('Landing page created successfully!', 'success');
      }

      setShowLandingModal(false);
      fetchUserLandingPages();
    } catch (err) {
      showToast(err.message || 'Failed to save landing page.', 'error');
    } finally {
      setLandingModalLoading(false);
    }
  };

  const handleDeleteLandingPage = async (id) => {
    if (!window.confirm('Are you sure you want to delete this landing page?')) return;
    try {
      const { error } = await supabase
        .from('landing_pages')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
      if (error) throw error;
      showToast('Landing page removed.', 'info');
      fetchUserLandingPages();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  };

  const handleGenerateLandingQr = (slug) => {
    const fullUrl = `${window.location.origin}/p/${slug}`;
    setContentType('link');
    setPayloadUrl(fullUrl);
    setShowResult(false);
    nav('app');
    showToast(`Loaded /p/${slug} into QR Generator!`, 'info');
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLogoName(file.name);
    if (errorLevel === 'L' || errorLevel === 'M') setErrorLevel('Q');
    const reader = new FileReader();
    reader.onload = (ev) => setLogoDataUrl(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => { setLogoDataUrl(''); setLogoName(''); };

  // Dynamic QR generation — requires login; calls server to create redirect
  const handleGenerateQr = async () => {
    if (!session) { nav('login'); return; }

    const payload = getPayload();
    if (!payload) { showToast('Please fill in the content fields.', 'error'); return; }
    if (contentType === 'link' && !isValidHttpUrl(payload)) {
      showToast('Please enter a valid https:// URL.', 'error');
      return;
    }
    if (contentType === 'upi') {
      if (!UPI_REGEX.test(upi.vpa.trim())) {
        showToast('Please enter a valid UPI ID (e.g. name@okhdfcbank).', 'error');
        return;
      }
      if (!upi.name.trim()) {
        showToast('Please enter the payee or business name.', 'error');
        return;
      }
    }

    setIsGenerating(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/qr/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // FIX: auth token from session, userId never in the body
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUrl: payload, contentType }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.limitExceeded) { setShowPremiumGate(true); return; }
        throw new Error(data.error);
      }

      setActiveShortCode(data.shortCode);
      const qrData = contentType === 'link' ? data.dynamicUrl : payload;
      lastEncodedDataRef.current = qrData;
      qrInstanceRef.current.update({ ...currentQrOpts(), data: qrData });
      setShowResult(true);
    } catch (err) {
      showToast(err.message || 'Generation failed. Please try again.', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  // Static QR generation — works for guests too; calls server redirect
  const handleGenerateStaticQr = async () => {
    if (!session) { nav('login'); return; }
    const payload = getPayload();
    if (!payload) { showToast('Please fill in the content fields.', 'error'); return; }
    if (contentType === 'link' && !isValidHttpUrl(payload)) {
      showToast('Please enter a valid https:// URL.', 'error');
      return;
    }
    // Check inside handleGenerateQr & handleGenerateStaticQr:
    if (contentType === 'upi') {
      if (!UPI_REGEX.test(upi.vpa.trim())) {
        showToast('Please enter a valid UPI ID (e.g. name@okhdfcbank).', 'error');
        return;
      }
      if (!upi.name.trim()) {
        showToast('Please enter the payee or business name.', 'error');
        return;
      }
    }

    // The QR encodes the raw destination directly (calls server redirect)
    lastEncodedDataRef.current = payload;
    qrInstanceRef.current.update({ ...currentQrOpts(), data: payload });
    setActiveShortCode('');   // no short code for static QRs
    setShowResult(true);

    // If logged in, silently save metadata to dashboard (non-blocking)
    if (session) {
      fetch(`${BACKEND_URL}/api/qr/save-static`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ targetUrl: payload, contentType }),
      }).catch(() => { });
    }
  };

  const handleDownload = async (fmt = 'png') => {
    if (!qrInstanceRef.current) return;
    qrInstanceRef.current.download({ name: 'qrscoop-code', extension: fmt });

    // Only log downloads for saved dynamic QRs (static QRs have no shortCode)
    if (activeShortCode && session) {
      await fetch(`${BACKEND_URL}/api/qr/log-download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ shortCode: activeShortCode }),
      }).catch(() => { });
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    const endpoint = isSignUp ? '/api/auth/signup' : '/api/auth/login';
    const payload = isSignUp
      ? { email: authForm.email, password: authForm.password, name: authForm.name }
      : { email: authForm.email, password: authForm.password };

    try {
      const res = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication error.');

      if (isSignUp) {
        showToast('Check your email to confirm your account, then log in.', 'success');
        setIsSignUp(false);
      } else {
        // FIX: use setSession() so the Supabase SDK manages the session
        // properly (including automatic token refresh)
        if (data.session) {
          await supabase.auth.setSession(data.session);
          // onAuthStateChange SIGNED_IN event will set session state + navigate
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleOAuth = async () => {
    try {
      let locationData = 'Unknown';
      try {
        const ipRes = await fetch('https://ipapi.co/json/');
        if (ipRes.ok) {
          const ipJson = await ipRes.json();
          locationData = `${ipJson.city}, ${ipJson.country_name}`;
        } else {
          throw new Error('Primary API failed');
        }
      } catch {
        try {
          // FIX: was http:// (insecure, blocked by browsers on HTTPS pages)
          const backupRes = await fetch('https://ipwho.is/');
          const backupJson = await backupRes.json();
          if (backupJson.success) {
            locationData = `${backupJson.city}, ${backupJson.country}`;
          }
        } catch {
          locationData = 'Unknown';
        }
      }
      localStorage.setItem('pending_signup_location', locationData);

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
          queryParams: { access_type: 'offline', prompt: 'consent' },
        },
      });
      if (error) throw error;
    } catch (err) {
      showToast('Google sign-in failed: ' + err.message, 'error');
    }
  };

  // FIX: removed wrong localStorage.removeItem('supabase.auth.token') —
  // Supabase v2 does not use that key. signOut() clears its own storage.
  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      // onAuthStateChange SIGNED_OUT event handles state reset + view navigation
    } catch (err) {
      console.error('Logout error:', err.message);
    }
    setMenuOpen(false);
  };

  const loadRazorpay = () => new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

  const openRazorpay = async (upiOnly = false) => {
    if (!session) { nav('login'); return; }
    const ok = await loadRazorpay();
    if (!ok) { showToast('Failed to load payment SDK.', 'error'); return; }

    try {
      const res = await fetch(`${BACKEND_URL}/api/payments/create-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // FIX: auth token, not userId in body
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);

      const opts = {
        key: import.meta.env.VITE_RAZORPAY_KEY_ID,
        amount: d.order.amount,
        currency: d.order.currency,
        name: 'QRScoop',
        description: 'Dynamic Tracking Pro',
        order_id: d.order.id,
        ...(upiOnly ? { prefill: { method: 'upi' } } : {}),
        handler: async (response) => {
          const vr = await fetch(`${BACKEND_URL}/api/payments/verify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // FIX: userId comes from the verified token on the server
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(response), // only Razorpay fields — no userId
          });
          const vd = await vr.json();
          if (vd.success) {
            showToast('Payment successful! Account upgraded to Pro ✅', 'success');
            setShowPremiumGate(false);
            setIsPremium(true);
          } else {
            showToast('Verification failed. Please contact support.', 'error');
          }
        },
        theme: { color: '#1d4ed8' },
      };

      const rzp = new window.Razorpay(opts);
      rzp.on('payment.failed', (r) => showToast(`Payment failed: ${r.error.description}`, 'error'));
      rzp.open();
    } catch (err) {
      showToast('Payment init failed: ' + err.message, 'error');
    }
  };

  // Handle CSV Upload & Parsing
  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCsvFileName(file.name);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (!results.data || results.data.length === 0) {
          showToast('CSV file is empty or formatted incorrectly.', 'error');
          return;
        }

        // Validate presence of URL or UPI columns
        const sample = results.data[0];
        const lowerKeys = Object.keys(sample).map(k => k.trim().toLowerCase());
        const hasStandardPayload = lowerKeys.some(k => ['url', 'link', 'data', 'content'].includes(k));
        const hasUpiPayload = lowerKeys.some(k => ['upi_id', 'vpa', 'upi'].includes(k));

        if (!hasStandardPayload && !hasUpiPayload) {
          showToast('CSV must contain either a "url" column OR a "upi_id" column.', 'error');
          return;
        }

        setCsvData(results.data);
        showToast(`Loaded ${results.data.length} records from CSV.`, 'success');
      },
      error: () => {
        showToast('Failed to parse CSV file.', 'error');
      },
    });
  };

  // Download Sample CSV
  const handleDownloadSampleCsv = () => {
    const csvContent = "data:text/csv;charset=utf-8," 
      + "filename,url\n"
      + "website,https://qrscoop.com\n"
      + "instagram,https://instagram.com/qrscoop\n"
      + "google,https://google.com\n";
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "qrscoop_sample.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Download Sample UPI CSV
  const handleDownloadSampleUpiCsv = () => {
    const csvContent = "data:text/csv;charset=utf-8,"
      + "filename,upi_id,payee,amount,note\n"
      + "Table_01,merchant@icici,Royal Cafe,250.00,Table 1 Order\n"
      + "Table_02,merchant@icici,Royal Cafe,420.00,Table 2 Order\n"
      + "Invoice_101,merchant@icici,Royal Cafe,1500.00,Invoice #101\n"
      + "Donation_Box,ngo@okhdfcbank,Help Foundation,,Charity\n";
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "qrscoop_upi_sample.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Process & Download ZIP with URL + UPI Support
  const handleGenerateBulkZip = async () => {
    if (!session) { nav('login'); return; }

    // Pro tier gate: free users are limited to 3 trial rows
    if (!isPremium && csvData.length > 3) {
      setShowPremiumGate(true);
      return;
    }

    setIsBulkProcessing(true);
    setBulkProgress(0);

    const zip = new JSZip();
    const folder = zip.folder('qrscoop-codes');

    try {
      for (let i = 0; i < csvData.length; i++) {
        const row = csvData[i];

        // Sanitize file naming
        const rawName = row.filename || row.name || `qr-code-${i + 1}`;
        const name = String(rawName).trim().replace(/[^a-z0-9_-]/gi, '_');

        let payload = '';

        // ── 1. Check for UPI fields first ──
        const vpa = row.upi_id || row.vpa || row.upi || row.UPI_ID || row.VPA;
        const payee = row.payee || row.payee_name || row.name || row.PAYEE;
        const amount = row.amount || row.AMOUNT;
        const note = row.note || row.remarks || row.NOTE;

        if (vpa && payee) {
          const params = new URLSearchParams();
          params.append('pa', vpa.trim());
          params.append('pn', payee.trim());
          if (amount && parseFloat(amount) > 0) {
            params.append('am', parseFloat(amount).toFixed(2));
          }
          params.append('cu', 'INR');
          if (note && note.trim()) {
            params.append('tn', note.trim());
          }
          payload = `upi://pay?${params.toString()}`;
        } else {
          // ── 2. Fall back to standard URL/text column ──
          payload = row.url || row.link || row.data || row.content || '';
        }

        if (!payload) continue;

        // Render QR styling using active designer state
        const qr = new QRCodeStyling({
          width: 500,
          height: 500,
          type: 'canvas',
          data: payload,
          image: logoDataUrl || undefined,
          qrOptions: { errorCorrectionLevel: errorLevel },
          imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35 },
          dotsOptions: useGradient
            ? {
              type: dotStyle,
              gradient: {
                type: 'linear',
                rotation: 45,
                colorStops: [{ offset: 0, color: gradFrom }, { offset: 1, color: gradTo }],
              },
            }
            : { type: dotStyle, color: dotColor },
          backgroundOptions: bgTransparent ? { color: 'transparent' } : { color: bgColor },
          cornersSquareOptions: { type: cornerStyle, color: syncCorner ? dotColor : cornerColor },
          cornersDotOptions: { type: cornerStyle === 'dot' ? 'dot' : 'square', color: syncCorner ? dotColor : cornerColor },
        });

        const blob = await qr.getRawData('png');
        folder.file(`${name}.png`, blob);

        setBulkProgress(Math.round(((i + 1) / csvData.length) * 100));
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `QRScoop-Bulk-${Date.now()}.zip`);
      showToast('Bulk ZIP downloaded successfully! 🚀', 'success');
    } catch (err) {
      showToast('Error during bulk generation: ' + err.message, 'error');
    } finally {
      setIsBulkProcessing(false);
      setBulkProgress(0);
    }
  };
  
  // ── Nav helper ────────────────────────────────────────────────────────────
  const nav = (v) => {
    navigate(ROUTE_MAP[v] || '/');
    setMenuOpen(false);
    window.scrollTo(0, 0);
  };
  const NAV_ITEMS = [
    { label: 'Generator', view: 'app' },
    { label: 'Bulk QR 👑',   view: 'bulk' },
    { label: 'How to Use', view: 'howto' },
    { label: 'For Business', view: 'marketing' },
    { label: 'QR Guide', view: 'guide' },
    { label: 'Pricing', view: 'pricing' },
  ];

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="bg-[#f8fafc] text-slate-800 min-h-screen flex flex-col font-sans antialiased">

      {/* ── TOAST STACK ─────────────────────────────────────────────────────── */}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl border text-sm font-semibold max-w-xs animate-fade-in transition-all ${t.type === 'success' ? 'bg-green-50 border-green-200 text-green-800'
              : t.type === 'error' ? 'bg-red-50 border-red-200 text-red-800'
                : 'bg-blue-50 border-blue-200 text-blue-800'
              }`}
          >
            <span className="text-base mt-0.5 shrink-0">
              {t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : 'ℹ️'}
            </span>
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>

      {/* ── NAVBAR ───────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 w-full z-50 bg-white/90 backdrop-blur-md border-b border-slate-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-3.5 flex items-center justify-between">
          <button onClick={() => nav('landing')} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-black text-white text-sm shadow">Q</div>
            <span className="font-black text-xl tracking-tight text-slate-900">QRScoop</span>
          </button>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-6 text-[13px] font-semibold">
            {NAV_ITEMS.map(item => (
              <button key={item.view} onClick={() => nav(item.view)}
                className={`transition ${view === item.view ? 'text-blue-600' : 'text-slate-500 hover:text-slate-900'}`}>
                {item.label}
              </button>
            ))}
            <button onClick={() => nav(userId ? 'dashboard' : 'login')}
              className="ml-2 bg-slate-900 text-white text-[13px] font-bold px-5 py-2 rounded-full shadow hover:bg-slate-700 transition">
              {userId ? 'Dashboard' : 'Sign In'}
            </button>
          </div>

          {/* Mobile hamburger */}
          <button onClick={() => setMenuOpen(!menuOpen)} className="md:hidden text-xl text-slate-600 p-1">
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>

        {menuOpen && (
          <div className="md:hidden bg-white border-t border-slate-100 px-6 py-4 flex flex-col gap-3 text-[14px] font-semibold shadow-xl">
            {NAV_ITEMS.map(item => (
              <button key={item.view} onClick={() => nav(item.view)}
                className={`text-left py-1.5 ${view === item.view ? 'text-blue-600' : 'text-slate-600'}`}>
                {item.label}
              </button>
            ))}
            <button onClick={() => nav(userId ? 'dashboard' : 'login')}
              className="mt-1 bg-slate-900 text-white text-center py-3 rounded-xl font-bold">
              {userId ? 'Dashboard' : 'Sign In'}
            </button>
          </div>
        )}
      </nav>

      <main className="flex-grow pt-20">

        {/* ═══════════════════════════════════════════════════════════════════
            LANDING VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'landing' && (
          <div className="w-full">
            {/* Hero */}
            <section className="max-w-7xl mx-auto px-4 md:px-8 py-16 md:py-24 grid md:grid-cols-2 gap-12 items-center">
              <div className="space-y-6">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-600 border border-blue-100">
                  ✨ Free to get started — no credit card needed
                </span>

                {/* FIX 1: SEO-optimized H1 targeting US search queries */}
                <h1 className="text-4xl sm:text-5xl md:text-6xl font-black text-slate-900 tracking-tight leading-[1.1]">
                  Free QR Code Generator —{' '}
                  <span className="text-blue-600">Custom Colors, Logo & Scan Tracking</span>
                </h1>

                <p className="text-slate-500 text-base sm:text-lg leading-relaxed font-medium max-w-lg">
                  Create beautiful, branded QR codes in seconds. Customize dot styles, colors, and embed your logo. Track every scan in real time — no account needed for static QR codes.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 pt-2">
                  <button onClick={() => nav('app')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-8 py-3.5 rounded-full shadow-lg shadow-blue-500/25 transition">
                    Create Your QR Code →
                  </button>
                  <button onClick={() => nav('howto')} className="text-slate-700 font-bold px-6 py-3.5 rounded-full border border-slate-200 hover:border-slate-300 bg-white transition">
                    See How It Works
                  </button>
                </div>
                <div className="flex items-center gap-6 pt-2 text-sm font-semibold text-slate-500">
                  <span className="flex items-center gap-1.5">✅ Free static QR codes</span>
                  <span className="flex items-center gap-1.5">✅ No watermarks</span>
                  <span className="flex items-center gap-1.5">✅ PNG & SVG export</span>
                </div>
              </div>

              <div className="flex justify-center">
                <div className="relative">
                  <div className="absolute inset-0 bg-blue-200 blur-3xl opacity-30 rounded-full scale-110" />
                  <div className="relative bg-white rounded-3xl shadow-2xl p-8 space-y-4 max-w-sm">
                    <div className="grid grid-cols-3 gap-2">
                      {['🌐 URL', '📶 WiFi', '👤 vCard'].map(t => (
                        <div key={t} className="bg-blue-50 text-blue-700 text-[11px] font-bold py-2 px-2 rounded-lg text-center">{t}</div>
                      ))}
                    </div>
                    <div className="bg-slate-50 rounded-2xl p-6 flex items-center justify-center border border-dashed border-slate-200">
                      <div className="w-24 h-24 grid grid-cols-3 gap-1">
                        {Array(9).fill(0).map((_, i) => (
                          <div key={i} className={`rounded-sm ${[0, 2, 6, 8, 4].includes(i) ? 'bg-blue-600' : 'bg-slate-200'}`} />
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[10px] font-bold text-slate-500 text-center">
                      <div className="bg-slate-50 rounded-lg py-1.5 border border-slate-100">Rounded dots</div>
                      <div className="bg-blue-600 text-white rounded-lg py-1.5">Custom color</div>
                      <div className="bg-slate-50 rounded-lg py-1.5 border border-slate-100">Logo embed</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Features */}
            <section className="max-w-7xl mx-auto px-4 md:px-8 py-16 md:py-20">
              <div className="text-center mb-12">
                <h2 className="text-3xl md:text-4xl font-black text-slate-900 mb-3">Everything you need in one place</h2>
                <p className="text-slate-500 font-medium max-w-xl mx-auto">From basic link QRs to fully branded codes with real-time scan analytics.</p>
              </div>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-6">
                {[
                  { icon: '🎨', title: 'Full Design Control', desc: 'Customize dot shapes, corner styles, colors, gradients, and embed your logo. Make it unmistakably yours.' },
                  { icon: '📊', title: 'Real-Time Analytics', desc: 'Track every scan. See when your QR was scanned, how many times, and monitor download counts.' },
                  { icon: '🔄', title: 'Dynamic Redirection', desc: 'Change your QR destination URL anytime — without reprinting. Perfect for campaigns and menus.' },
                  { icon: '📁', title: 'Multiple Content Types', desc: 'URLs, WiFi credentials, vCard contacts, and plain text — all supported with optimized encoding.' },
                  { icon: '🖼️', title: 'Logo Embedding', desc: 'Upload your brand logo and embed it at the center of your QR code with automatic error correction.' },
                  { icon: '⬇️', title: 'PNG & SVG Export', desc: 'Download in pixel-perfect PNG for web or crisp SVG for print. No quality loss at any size.' },
                ].map(f => (
                  <div key={f.title} className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm hover:shadow-md transition space-y-3">
                    <div className="text-3xl">{f.icon}</div>
                    <h3 className="font-black text-slate-900 text-lg">{f.title}</h3>
                    <p className="text-slate-500 text-sm leading-relaxed font-medium">{f.desc}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* FIX 2: FAQ Section — matches schema markup in index.html */}
            <section className="max-w-4xl mx-auto px-4 md:px-8 py-16">
              <div className="text-center mb-10">
                <h2 className="text-3xl md:text-4xl font-black text-slate-900 mb-3">Frequently Asked Questions</h2>
                <p className="text-slate-500 font-medium">Everything you need to know about QRScoop.</p>
              </div>
              <div className="space-y-4">
                {[
                  {
                    q: 'Is QRScoop free to use?',
                    a: 'Yes! QRScoop offers free static QR codes with no account required. You can customize colors, add a logo, and download in PNG or SVG format instantly. Create a free account to unlock dynamic QR codes with real-time scan tracking.',
                  },
                  {
                    q: 'Can I create a QR code with my own logo?',
                    a: 'Absolutely. QRScoop lets you upload and embed your logo directly into any QR code. It\'s placed at the center with automatic error correction so the code stays scannable.',
                  },
                  {
                    q: 'What is a dynamic QR code?',
                    a: 'A dynamic QR code lets you change the destination URL at any time after printing — no need to reprint. It also tracks how many times the code was scanned, giving you real-time scan analytics.',
                  },
                  {
                    q: 'Do I need to create an account?',
                    a: 'No account is needed for static QR codes. Simply open QRScoop, customize your code, and download it instantly. Sign up for free to unlock dynamic QR codes, scan tracking, and a personal dashboard.',
                  },
                  {
                    q: 'What file formats can I download?',
                    a: 'You can download your QR code as a PNG (perfect for web and digital use) or SVG (ideal for print at any size without quality loss).',
                  },
                  {
                    q: 'What types of QR codes can I create?',
                    a: 'QRScoop supports URL QR codes, WiFi QR codes, vCard contact QR codes, and plain text QR codes — all with full design customization.',
                  },
                ].map(({ q, a }) => (
                  <details key={q} className="group bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
                    <summary className="flex items-center justify-between px-6 py-5 cursor-pointer list-none">
                      <h3 className="font-black text-slate-900 text-base pr-4">{q}</h3>
                      <span className="text-slate-400 text-xl font-black shrink-0 group-open:rotate-45 transition-transform">+</span>
                    </summary>
                    <p className="px-6 pb-5 text-slate-500 text-sm leading-relaxed font-medium">{a}</p>
                  </details>
                ))}
              </div>
            </section>

            {/* CTA */}
            <section className="max-w-7xl mx-auto px-4 md:px-8 pb-20">
              <div className="bg-slate-900 rounded-3xl p-10 md:p-16 text-center text-white space-y-5">
                <h2 className="text-3xl md:text-4xl font-black">Start creating for free today</h2>
                <p className="text-slate-400 font-medium max-w-lg mx-auto">Create a free account to generate, customize, and save both static and dynamic QR codes.</p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
                  <button onClick={() => nav('app')} className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-8 py-3.5 rounded-full transition shadow-lg">
                    Generate Free QR →
                  </button>
                  <button onClick={() => nav('pricing')} className="text-white font-bold px-8 py-3.5 rounded-full border border-white/20 hover:border-white/40 transition">
                    View Pricing
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            QR GENERATOR + DESIGNER VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'app' && (
          <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 md:py-8">
            <div className="grid md:grid-cols-12 gap-6 items-start">

              {/* ── LEFT PANEL ─────────────────────────────────────────────── */}
              <div className="md:col-span-7 space-y-4">

                {/* ── QR MODE SWITCHER (NEW) ──────────────────────────────── */}
                <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-4">
                  <p className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-3">QR Code Type</p>
                  <div className="flex gap-2 p-1 bg-slate-100 rounded-xl">
                    <button
                      onClick={() => { setQrMode('dynamic'); setShowResult(false); lastEncodedDataRef.current = null; }}
                      className={`flex-1 py-2.5 px-3 text-xs font-bold rounded-lg transition flex items-center justify-center gap-1.5 ${qrMode === 'dynamic'
                        ? 'bg-white text-blue-700 shadow border border-blue-100'
                        : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      ⚡ Dynamic QR
                    </button>
                    <button
                      onClick={() => { setQrMode('static'); setShowResult(false); lastEncodedDataRef.current = null; }}
                      className={`flex-1 py-2.5 px-3 text-xs font-bold rounded-lg transition flex items-center justify-center gap-1.5 ${qrMode === 'static'
                        ? 'bg-white text-slate-900 shadow border border-slate-200'
                        : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      📄 Static QR
                    </button>
                  </div>

                  {/* Mode description */}
                  <div className={`mt-3 rounded-xl px-4 py-3 text-xs font-medium leading-relaxed ${qrMode === 'dynamic'
                    ? 'bg-blue-50 text-blue-700 border border-blue-100'
                    : 'bg-slate-50 text-slate-600 border border-slate-100'
                    }`}>
                    {qrMode === 'dynamic' ? (
                      <>
                        <span className="font-black">Dynamic:</span> QR routes through QRScoop's server so you get scan analytics and a permanent short URL. Free users get 2 trial codes (expire after 7 days). Upgrade for unlimited + permanent links.
                        {!userId && <span className="block mt-1 text-blue-600 font-bold">→ Sign in required to generate a Dynamic QR.</span>}
                      </>
                    ) : (
                      <>
                        <span className="font-black">Static:</span> QR encodes your destination directly — no server redirect, no expiry, no tracking. Works forever.
                        {!userId && <span className="block mt-1 text-blue-600 font-bold">→ Sign in required to generate a Static QR.</span>}
                      </>
                    )}
                  </div>
                </div>

                {/* Tab bar: Content / Design / Settings */}
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                  <div className="flex border-b border-slate-100">
                    {[['content', '📝 Content'], ['design', '🎨 Design'], ['settings', '⚙️ Settings']].map(([t, label]) => (
                      <button key={t} onClick={() => setDesignTab(t)}
                        className={`flex-1 py-3.5 text-xs font-bold transition ${designTab === t ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/30' : 'text-slate-500 hover:text-slate-700'}`}>
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="p-5 md:p-6 space-y-5">

                    {/* ── CONTENT TAB ─────────────────────────────────────── */}
                    {designTab === 'content' && (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                          {[
                            { id: 'link', l: 'Website URL', i: '🌐' },
                            { id: 'upi', l: 'UPI Pay', i: '🇮🇳' },
                            { id: 'wifi', l: 'Wi-Fi', i: '📶' },
                            { id: 'text', l: 'Plain Text', i: '📝' },
                            { id: 'vcard', l: 'vCard', i: '👤' }
                          ].map(t => (
                            <button key={t.id} onClick={() => { setContentType(t.id); setShowResult(false); }}
                              className={`p-3.5 rounded-xl border flex flex-col items-center gap-2 transition cursor-pointer text-center ${contentType === t.id ? 'border-blue-600 bg-blue-50 text-blue-700 font-bold' : 'border-slate-100 bg-slate-50 text-slate-600 hover:border-slate-200'
                                }`}>
                              <span className="text-2xl">{t.i}</span>
                              <span className="text-[11px] font-bold">{t.l}</span>
                            </button>
                          ))}
                        </div>

                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">Content Details</label>
                          {contentType === 'link' && (
                            <input type="url" value={payloadUrl} onChange={e => setPayloadUrl(e.target.value)}
                              placeholder="https://your-website.com"
                              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500" />
                          )}
                          {contentType === 'wifi' && (
                            <div className="space-y-3">
                              <div className="grid sm:grid-cols-2 gap-3">
                                <input type="text" value={wifiName} onChange={e => setWifiName(e.target.value)} placeholder="Network Name (SSID)"
                                  className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500" />
                                <input type="password" value={wifiPass} onChange={e => setWifiPass(e.target.value)} placeholder="Password"
                                  className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500"
                                  disabled={wifiSecurity === 'nopass'} />
                              </div>
                              <div className="flex gap-2">
                                {[['WPA', 'WPA / WPA2'], ['WEP', 'WEP'], ['nopass', 'No Password']].map(([val, label]) => (
                                  <button key={val} onClick={() => { setWifiSecurity(val); if (val === 'nopass') setWifiPass(''); }}
                                    className={`flex-1 py-2 text-xs font-bold rounded-xl border transition ${wifiSecurity === val ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {contentType === 'text' && (
                            <textarea rows={3} value={rawText} onChange={e => setRawText(e.target.value)} placeholder="Enter your text or message..."
                              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500 resize-none" />
                          )}
                          {contentType === 'vcard' && (
                            <div className="grid sm:grid-cols-3 gap-3">
                              <input type="text" value={vcard.name} onChange={e => setVcard({ ...vcard, name: e.target.value })} placeholder="Full Name"
                                className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500" />
                              <input type="text" value={vcard.phone} onChange={e => setVcard({ ...vcard, phone: e.target.value })} placeholder="+91 98765 43210"
                                className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500" />
                              <input type="email" value={vcard.email} onChange={e => setVcard({ ...vcard, email: e.target.value })} placeholder="email@domain.com"
                                className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500" />
                            </div>
                          )}
                          {contentType === 'upi' && (
                            <div className="space-y-3">
                              <div className="grid sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] font-bold text-slate-500 mb-1">UPI ID / VPA *</label>
                                  <input
                                    type="text"
                                    value={upi.vpa}
                                    onChange={e => setUpi({ ...upi, vpa: e.target.value })}
                                    placeholder="merchant@okhdfcbank"
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-bold text-slate-500 mb-1">Payee Name *</label>
                                  <input
                                    type="text"
                                    value={upi.name}
                                    onChange={e => setUpi({ ...upi, name: e.target.value })}
                                    placeholder="Business or Store Name"
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500"
                                  />
                                </div>
                              </div>
                              <div className="grid sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] font-bold text-slate-500 mb-1">Requested Amount (₹) (Optional)</label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={upi.amount}
                                    onChange={e => setUpi({ ...upi, amount: e.target.value })}
                                    placeholder="Leave blank for open amount"
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-bold text-slate-500 mb-1">Transaction Note (Optional)</label>
                                  <input
                                    type="text"
                                    value={upi.note}
                                    onChange={e => setUpi({ ...upi, note: e.target.value })}
                                    placeholder="Order #102 or Tips"
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:border-blue-500"
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* ── DESIGN TAB ──────────────────────────────────────── */}
                    {designTab === 'design' && (
                      <div className="space-y-6">
                        {/* Dot Style */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">Dot Style</label>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                            {DOT_STYLES.map(s => (
                              <button key={s.id} onClick={() => setDotStyle(s.id)}
                                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition ${dotStyle === s.id ? 'border-blue-600 bg-blue-50' : 'border-slate-100 hover:border-slate-200'}`}>
                                <svg viewBox="0 0 16 16" className={`w-7 h-7 ${dotStyle === s.id ? 'fill-blue-600' : 'fill-slate-400'}`}>
                                  <path d={s.svg} />
                                </svg>
                                <span className="text-[10px] font-bold text-slate-500">{s.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Dot Color */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">Dot Color</label>
                          <div className="flex items-center gap-3 flex-wrap">
                            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                              <input type="checkbox" checked={useGradient} onChange={e => setUseGradient(e.target.checked)} className="rounded" />
                              Use gradient
                            </label>
                          </div>
                          {!useGradient ? (
                            <div className="flex items-center gap-2 mt-3 flex-wrap">
                              {PALETTE.map(c => (
                                <button key={c} onClick={() => setDotColor(c)}
                                  className={`w-7 h-7 rounded-full border-2 transition ${dotColor === c ? 'border-blue-600 scale-110' : 'border-transparent'}`}
                                  style={{ backgroundColor: c }} />
                              ))}
                              <input type="color" value={dotColor} onChange={e => setDotColor(e.target.value)}
                                className="w-7 h-7 rounded-full border-2 border-slate-200 cursor-pointer overflow-hidden" title="Custom color" />
                            </div>
                          ) : (
                            <div className="mt-3 space-y-3">
                              <div className="flex gap-2 flex-wrap">
                                {GRADIENT_PRESETS.map(g => (
                                  <button key={g.label} onClick={() => { setGradFrom(g.from); setGradTo(g.to); }}
                                    className="text-[10px] font-bold px-3 py-1.5 rounded-full text-white shadow"
                                    style={{ background: `linear-gradient(135deg, ${g.from}, ${g.to})` }}>
                                    {g.label}
                                  </button>
                                ))}
                              </div>
                              <div className="flex items-center gap-3">
                                <label className="text-xs font-semibold text-slate-500">From</label>
                                <input type="color" value={gradFrom} onChange={e => setGradFrom(e.target.value)} className="w-8 h-8 rounded-lg border-2 border-slate-200 cursor-pointer" />
                                <div className="flex-1 h-5 rounded-full" style={{ background: `linear-gradient(90deg, ${gradFrom}, ${gradTo})` }} />
                                <input type="color" value={gradTo} onChange={e => setGradTo(e.target.value)} className="w-8 h-8 rounded-lg border-2 border-slate-200 cursor-pointer" />
                                <label className="text-xs font-semibold text-slate-500">To</label>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Corner Style */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">Corner Style</label>
                          <div className="flex gap-2">
                            {CORNER_STYLES.map(s => (
                              <button key={s.id} onClick={() => setCornerStyle(s.id)}
                                className={`flex-1 py-2 text-xs font-bold rounded-xl border transition ${cornerStyle === s.id ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-100 text-slate-500 hover:border-slate-200'}`}>
                                {s.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Corner Color */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-2">Corner Color</label>
                          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer mb-3">
                            <input type="checkbox" checked={syncCorner} onChange={e => setSyncCorner(e.target.checked)} className="rounded" />
                            Sync with dot color
                          </label>
                          {!syncCorner && (
                            <div className="flex items-center gap-2 flex-wrap">
                              {PALETTE.map(c => (
                                <button key={c} onClick={() => setCornerColor(c)}
                                  className={`w-7 h-7 rounded-full border-2 transition ${cornerColor === c ? 'border-blue-600 scale-110' : 'border-transparent'}`}
                                  style={{ backgroundColor: c }} />
                              ))}
                              <input type="color" value={cornerColor} onChange={e => setCornerColor(e.target.value)}
                                className="w-7 h-7 rounded-full border-2 border-slate-200 cursor-pointer overflow-hidden" />
                            </div>
                          )}
                        </div>

                        {/* Background */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-2">Background Color</label>
                          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer mb-3">
                            <input type="checkbox" checked={bgTransparent} onChange={e => setBgTransparent(e.target.checked)} className="rounded" />
                            Transparent background
                          </label>
                          {!bgTransparent && (
                            <div className="flex items-center gap-2 flex-wrap">
                              {['#ffffff', '#f8fafc', '#1e293b', '#fef9c3', '#eff6ff', '#f0fdf4'].map(c => (
                                <button key={c} onClick={() => setBgColor(c)}
                                  className={`w-7 h-7 rounded-full border-2 transition ${bgColor === c ? 'border-blue-600 scale-110' : 'border-slate-200'}`}
                                  style={{ backgroundColor: c }} />
                              ))}
                              <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)}
                                className="w-7 h-7 rounded-full border-2 border-slate-200 cursor-pointer overflow-hidden" />
                            </div>
                          )}
                        </div>

                        {/* Logo */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">Logo / Icon</label>
                          {logoDataUrl ? (
                            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                              <img src={logoDataUrl} className="w-10 h-10 rounded-lg object-contain border border-slate-200 bg-white" alt="logo" />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-slate-700 truncate">{logoName}</p>
                                <p className="text-[10px] text-slate-400 font-medium mt-0.5">Error level auto-set to Q or higher</p>
                              </div>
                              <button onClick={handleRemoveLogo} className="text-red-500 hover:text-red-700 text-xs font-bold px-2 py-1 rounded-lg hover:bg-red-50 transition">Remove</button>
                            </div>
                          ) : (
                            <label className="flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed border-slate-200 rounded-xl cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition">
                              <span className="text-2xl">🖼️</span>
                              <span className="text-xs font-bold text-slate-500">Click to upload PNG, JPG, or SVG</span>
                              <span className="text-[10px] text-slate-400 font-medium">Recommended: square image with transparent background</span>
                              <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                            </label>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── SETTINGS TAB ────────────────────────────────────── */}
                    {designTab === 'settings' && (
                      <div className="space-y-6">
                        {/* Error Correction */}
                        <div>
                          <label className="block text-xs font-black uppercase tracking-wider text-slate-400 mb-3">
                            Error Correction Level
                            <span className="ml-2 normal-case font-medium text-slate-400">— Higher = more recoverable, larger QR</span>
                          </label>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {ERROR_LEVELS.map(l => (
                              <button key={l.id} onClick={() => setErrorLevel(l.id)}
                                className={`relative flex flex-col items-center gap-1 py-3 px-2 rounded-xl border text-center transition ${errorLevel === l.id ? 'border-blue-600 bg-blue-50' : 'border-slate-100 hover:border-slate-200'}`}>
                                {l.rec && <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-green-500 text-white text-[8px] font-bold px-2 py-0.5 rounded-full">Logo friendly</span>}
                                <span className={`text-base font-black ${errorLevel === l.id ? 'text-blue-600' : 'text-slate-700'}`}>{l.id}</span>
                                <span className={`text-[10px] font-bold ${errorLevel === l.id ? 'text-blue-600' : 'text-slate-500'}`}>{l.label}</span>
                                <span className="text-[9px] text-slate-400">{l.desc}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* QR Size */}
                        <div>
                          <div className="flex justify-between items-center mb-2">
                            <label className="text-xs font-black uppercase tracking-wider text-slate-400">Output Size</label>
                            <span className="text-xs font-bold text-blue-600">{qrSize} × {qrSize} px</span>
                          </div>
                          <input type="range" min="200" max="600" step="50" value={qrSize} onChange={e => setQrSize(Number(e.target.value))}
                            className="w-full accent-blue-600" />
                          <div className="flex justify-between text-[10px] text-slate-400 font-medium mt-1">
                            <span>200px (web)</span><span>400px (print)</span><span>600px (large print)</span>
                          </div>
                        </div>

                        {/* Tips */}
                        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-2">
                          <p className="text-xs font-black text-amber-700">💡 Pro Tips</p>
                          <ul className="text-[11px] text-amber-600 font-medium space-y-1 leading-relaxed">
                            <li>• Use <strong>Level Q or H</strong> when adding a logo — it keeps the QR scannable even with the image in the way.</li>
                            <li>• Minimum print size is <strong>2 cm × 2 cm</strong>. Go larger if the QR has lots of data.</li>
                            <li>• Always maintain a <strong>quiet zone</strong> (white border) around the QR code.</li>
                            <li>• High contrast between dots and background = better scan rate.</li>
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Generate Button */}
                <div className="relative">
                  {qrMode === 'dynamic' ? (
                    <button onClick={handleGenerateQr} disabled={isGenerating}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-500/20 transition text-sm">
                      {isGenerating ? 'Generating…' : '⚡ Generate & Save Dynamic QR'}
                    </button>
                  ) : (
                    <button onClick={handleGenerateStaticQr}
                      className="w-full bg-slate-900 hover:bg-slate-700 text-white font-bold py-4 rounded-xl shadow-lg transition text-sm">
                      📄 Generate Static QR — No tracking, no expiry
                    </button>
                  )}

                  {/* Premium gate overlay (dynamic mode only) */}
                  {showPremiumGate && (
                    <div className="absolute inset-0 bg-white/96 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center text-center p-6 gap-3 z-10 border border-blue-100">
                      <span className="text-3xl">👑</span>
                      <h3 className="font-black text-slate-900">Limit Reached</h3>
                      <p className="text-slate-500 text-xs max-w-xs font-medium">You have reached your limit of 2 free trial Dynamic QR codes. Upgrade to Pro for unlimited codes, analytics, and permanent links. Or switch to <button onClick={() => { setQrMode('static'); setShowPremiumGate(false); }} className="underline text-blue-600">Static QR</button> — it's always free.</p>
                      <div className="flex gap-2 w-full max-w-xs mt-1">
                        <button onClick={() => openRazorpay(false)} className="flex-1 bg-blue-600 text-white font-bold py-2.5 rounded-lg text-xs">💳 Pay with Card</button>
                        <button onClick={() => openRazorpay(true)} className="flex-1 bg-white border-2 border-blue-600 text-blue-600 font-bold py-2.5 rounded-lg text-xs">🇮🇳 Pay via UPI</button>
                      </div>
                      <button onClick={() => setShowPremiumGate(false)} className="text-slate-400 text-xs font-medium hover:text-slate-600 mt-1">Close</button>
                    </div>
                  )}
                </div>
              </div>

              {/* ── RIGHT PANEL: LIVE PREVIEW ───────────────────────────── */}
              <div className="md:col-span-5 md:sticky md:top-28">
                <div className="bg-white border border-slate-100 rounded-3xl shadow-lg p-6 md:p-8 flex flex-col items-center gap-5">
                  <div className="w-full flex items-center justify-between">
                    <span className="text-xs font-black uppercase tracking-widest text-slate-400">Live Preview</span>
                    {showResult && (
                      <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${qrMode === 'dynamic' ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-slate-100 text-slate-600'
                        }`}>
                        {qrMode === 'dynamic' ? '⚡ Dynamic' : '📄 Static'}
                      </span>
                    )}
                  </div>

                  {/* QR canvas */}
                  <div className="relative w-full">
                    <div className="rounded-2xl border-2 border-dashed bg-slate-50 border-slate-200 p-4 w-full flex items-center justify-center shadow-inner" style={{ minHeight: 260 }}>
                      <div
                        ref={qrContainerRef}
                        className={`flex items-center justify-center transition-all duration-700 ease-out transform ${!showResult ? 'opacity-25 scale-90 grayscale' : 'opacity-100 scale-100 grayscale-0'
                          }`}
                        style={{
                          filter: !showResult ? 'blur(4px)' : 'none',
                          userSelect: !showResult ? 'none' : 'auto',
                          pointerEvents: !showResult ? 'none' : 'auto',
                        }}
                      />
                      {!showResult && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                          <span className="bg-white/90 text-slate-400 text-xs font-black uppercase tracking-widest px-4 py-1.5 rounded-full shadow-sm border border-slate-100 animate-pulse">
                            Draft Preview
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Download section */}
                  {showResult ? (
                    /* Static QRs and dynamic QRs both get download buttons.
                       Static QRs require login. */
                    userId ? (
                      <div className="w-full space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <button onClick={() => handleDownload('png')}
                            className="bg-slate-900 hover:bg-slate-700 text-white font-bold py-3 rounded-xl text-xs transition shadow">
                            ⬇️ Download PNG
                          </button>
                          <button onClick={() => handleDownload('svg')}
                            className="bg-white hover:bg-slate-50 text-slate-900 font-bold py-3 rounded-xl text-xs transition shadow border border-slate-200">
                            ⬇️ Download SVG
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400 font-medium text-center">PNG for web · SVG for print (infinite resolution)</p>
                        {qrMode === 'static' && !userId && (
                          <p className="text-[10px] text-center text-slate-400 font-medium">
                            <button onClick={() => nav('login')} className="text-blue-600 font-bold hover:underline">Sign in</button> to save this QR to your dashboard
                          </p>
                        )}
                      </div>
                    ) : (
                      /* Dynamic QR with no login — prompt sign in */
                      <div className="w-full space-y-2">
                        <button onClick={() => nav('login')}
                          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-3 rounded-xl text-sm transition shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2">
                          Sign in to Download
                        </button>
                        <p className="text-[10px] text-center text-slate-400 font-medium">
                          Free account · No credit card · Saves all your QR codes
                        </p>
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-slate-400 font-medium text-center">Fill in content and click Generate to preview your QR code</p>
                  )}

                  {/* Design summary */}
                  <div className="w-full bg-slate-50 rounded-xl p-3 border border-slate-100 grid grid-cols-3 gap-2 text-center text-[10px]">
                    <div><div className="font-black text-slate-700 capitalize">{dotStyle.replace('-', ' ')}</div><div className="text-slate-400 mt-0.5">Dot style</div></div>
                    <div>
                      <div className="flex justify-center mb-0.5">
                        <div className="w-4 h-4 rounded-full border border-slate-200 mx-auto"
                          style={{ background: useGradient ? `linear-gradient(135deg,${gradFrom},${gradTo})` : dotColor }} />
                      </div>
                      <div className="text-slate-400">Color</div>
                    </div>
                    <div><div className="font-black text-slate-700">{errorLevel}</div><div className="text-slate-400 mt-0.5">Error lvl</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            HOW TO USE VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'howto' && (
          <div className="max-w-4xl mx-auto px-4 md:px-8 py-10 md:py-16 space-y-14">
            <div className="text-center space-y-3">
              <span className="inline-block px-3 py-1 bg-blue-50 text-blue-600 text-xs font-bold rounded-full border border-blue-100">Step-by-step guide</span>
              <h1 className="text-3xl md:text-5xl font-black text-slate-900">How to create a QR code</h1>
              <p className="text-slate-500 font-medium max-w-xl mx-auto">From zero to a scannable, branded QR code in under two minutes.</p>
            </div>
            <div className="space-y-6">
              {[
                { n: '01', title: 'Choose your content type', icon: '📁', desc: 'Select what your QR code will contain — a website link, Wi-Fi credentials, contact info (vCard), or plain text. Each type is encoded differently for maximum compatibility.', tip: 'Use a URL for the most universal scan support across all devices.' },
                { n: '02', title: 'Enter your content', icon: '✍️', desc: 'Fill in the specific details for your chosen type. For URLs, include the full address starting with https://. For WiFi, enter the exact network name (SSID) and password.', tip: 'Always double-check spelling — a typo in a URL means everyone who scans gets an error page.' },
                { n: '03', title: 'Customize your design', icon: '🎨', desc: 'Open the Design tab to choose dot shapes, corner styles, colors, gradients, and optionally embed your logo at the center. Pick high-contrast colors for better scan reliability.', tip: 'Round or dot-style patterns often look more modern. Square dots are the most universally scannable.' },
                { n: '04', title: 'Choose Static or Dynamic', icon: '⚡', desc: 'Static QR encodes your URL directly — free for everyone, works forever, no account needed. Dynamic QR routes through QRScoop so you get click analytics and can update the destination later.', tip: 'Use Static for permanent info (WiFi, vCards, menus you won\'t change). Use Dynamic for marketing campaigns.' },
                { n: '05', title: 'Generate and test', icon: '✅', desc: 'Click the Generate button. Then scan the result with your phone camera before downloading. Test with multiple devices and in different lighting conditions.', tip: 'Test on both iOS and Android. Some older Android devices need a dedicated scanner app.' },
                { n: '06', title: 'Download and deploy', icon: '⬇️', desc: 'Download PNG for digital use (websites, email, social media) or SVG for print (posters, banners, business cards). SVG scales infinitely without quality loss.', tip: 'For print under 5cm, increase the error correction level and test carefully before mass printing.' },
              ].map((s, i) => (
                <div key={i} className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
                  <div className="flex items-start gap-5 p-6">
                    <div className="shrink-0 w-12 h-12 bg-blue-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow">{s.n}</div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2"><span className="text-xl">{s.icon}</span><h3 className="font-black text-slate-900 text-lg">{s.title}</h3></div>
                      <p className="text-slate-500 text-sm leading-relaxed font-medium">{s.desc}</p>
                      <div className="flex items-start gap-2 bg-amber-50 rounded-lg p-3 mt-2">
                        <span className="text-amber-500 text-sm mt-0.5 shrink-0">💡</span>
                        <p className="text-amber-700 text-xs font-semibold leading-relaxed">{s.tip}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-4">
              <h2 className="text-2xl font-black text-slate-900 mb-6">Frequently asked questions</h2>
              {[
                { q: 'What\'s the difference between Static and Dynamic QR codes?', a: 'Static QR codes encode your content directly — once printed, they can\'t be changed. Dynamic QR codes point to a redirect URL on our server, so you can update the destination anytime without reprinting.' },
                { q: 'Yes, a free account is required to generate and download your QR codes. Free accounts include unlimited static QR codes and a 7-day trial for dynamic codes.' },
                { q: 'How small can I print my QR code?', a: 'The minimum recommended print size is 2cm × 2cm (about 0.75 inches). Smaller than that and most cameras struggle to focus. For complex QR codes (lots of data or high error correction), go at least 3–4cm.' },
                { q: 'Will a logo in the center break my QR code?', a: 'No — as long as your error correction level is set to Q (25%) or H (30%). QR codes are designed to remain scannable even when up to 30% of their surface is obscured.' },
                { q: 'Do QR codes expire?', a: 'Static QR codes never expire — they\'re just an image. Free Dynamic QR codes expire after 7 days. Upgrade to Pro for permanent dynamic links.' },
              ].map((f, i) => (
                <div key={i} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm">
                  <p className="font-black text-slate-900 text-sm mb-2">{f.q}</p>
                  <p className="text-slate-500 text-sm leading-relaxed font-medium">{f.a}</p>
                </div>
              ))}
            </div>
            <div className="bg-blue-600 rounded-3xl p-8 text-center text-white space-y-4">
              <h3 className="text-2xl font-black">Ready to create your first QR code?</h3>
              <p className="text-blue-200 font-medium">No account needed for static codes. Start generating in seconds.</p>
              <button onClick={() => nav('app')} className="bg-white text-blue-600 font-black px-8 py-3 rounded-full shadow-lg hover:bg-blue-50 transition">Open the Generator →</button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            BUSINESS MARKETING VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'marketing' && (
          <div className="w-full">
            <section className="max-w-4xl mx-auto px-4 md:px-8 py-12 md:py-16 text-center space-y-5">
              <span className="inline-block px-3 py-1 bg-green-50 text-green-700 text-xs font-bold rounded-full border border-green-100">Business & Marketing</span>
              <h1 className="text-3xl md:text-5xl font-black text-slate-900">QR codes as a marketing superpower</h1>
              <p className="text-slate-500 font-medium max-w-2xl mx-auto leading-relaxed">QR codes bridge the physical and digital worlds. Here's how smart businesses use them to drive engagement, reduce friction, and measure ROI.</p>
            </section>
            <section className="max-w-6xl mx-auto px-4 md:px-8 pb-14">
              <h2 className="text-2xl font-black text-slate-900 mb-6">Industry use cases</h2>
              <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-5">
                {[
                  { icon: '🍽️', industry: 'Restaurants & Cafes', uses: ['Digital menus — update prices anytime', 'Table-side WiFi sharing', 'Loyalty card sign-up', 'Google Review links', 'Online ordering'] },
                  { icon: '🛍️', industry: 'Retail & E-Commerce', uses: ['Product detail pages', 'Discount coupons & flash sales', 'Warranty registration', 'Unboxing experience links', 'Customer feedback forms'] },
                  { icon: '🎪', industry: 'Events & Entertainment', uses: ['Digital tickets & check-in', 'Event schedule / agenda', 'Social media follow prompts', 'Post-event survey links', 'Sponsor landing pages'] },
                  { icon: '🏢', industry: 'Real Estate', uses: ['Virtual tour links', 'Property spec sheets', 'Agent contact vCards', 'Neighborhood guides', 'Mortgage calculator links'] },
                  { icon: '🏥', industry: 'Healthcare', uses: ['Patient intake forms', 'Appointment booking', 'Health information sheets', 'Prescription pickup alerts', 'Telehealth session links'] },
                  { icon: '🎓', industry: 'Education', uses: ['Lesson plan & resource links', 'Attendance tracking', 'Assignment submission portals', 'Campus WiFi access', 'Course evaluation surveys'] },
                ].map(c => (
                  <div key={c.industry} className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5 space-y-3 hover:shadow-md transition">
                    <div className="text-3xl">{c.icon}</div>
                    <h3 className="font-black text-slate-900">{c.industry}</h3>
                    <ul className="space-y-1.5">
                      {c.uses.map(u => (
                        <li key={u} className="flex items-start gap-2 text-sm text-slate-500 font-medium">
                          <span className="text-green-500 text-xs mt-0.5 shrink-0">✓</span>{u}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
            <section className="bg-slate-900 py-14">
              <div className="max-w-4xl mx-auto px-4 md:px-8 space-y-10">
                <h2 className="text-2xl font-black text-white text-center">5 strategies that maximize QR performance</h2>
                <div className="space-y-4">
                  {[
                    { n: '1', title: 'Always add a call-to-action', desc: 'Never print a QR code without a text prompt. "Scan for menu", "Scan to get 20% off", or "Scan to book a table" dramatically increase scan rates.' },
                    { n: '2', title: 'Use dynamic QR for any printed material', desc: 'Menus, banners, flyers, and packaging all have long print runs. Dynamic QR lets you update the destination without reprinting a single piece.' },
                    { n: '3', title: 'Place QR codes where people have time to scan', desc: 'Tables, waiting rooms, checkout queues, and product packaging are ideal. Billboards at 60mph are not. Context matters.' },
                    { n: '4', title: 'Track and iterate with analytics', desc: 'Use dynamic QR\'s built-in scan tracking to measure which placements perform. Your data will show which drives the most action.' },
                    { n: '5', title: 'Brand your QR codes to build trust', desc: 'A branded code with your logo and brand colors signals authenticity. Branded QR codes see up to 80% higher scan rates than generic ones.' },
                  ].map(s => (
                    <div key={s.n} className="bg-white/5 border border-white/10 rounded-2xl p-5 flex gap-4">
                      <div className="w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center font-black shrink-0">{s.n}</div>
                      <div><h3 className="font-black text-white mb-1">{s.title}</h3><p className="text-slate-400 text-sm leading-relaxed font-medium">{s.desc}</p></div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            <section className="max-w-4xl mx-auto px-4 md:px-8 pb-16 text-center pt-14">
              <button onClick={() => nav('app')} className="bg-blue-600 hover:bg-blue-700 text-white font-black px-10 py-4 rounded-full shadow-lg shadow-blue-500/25 transition text-base">
                Start Building Branded QR Codes →
              </button>
            </section>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            QR GUIDE VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'guide' && (
          <div className="max-w-4xl mx-auto px-4 md:px-8 py-10 md:py-16 space-y-12">
            <div className="text-center space-y-3">
              <span className="inline-block px-3 py-1 bg-purple-50 text-purple-700 text-xs font-bold rounded-full border border-purple-100">Complete Reference</span>
              <h1 className="text-3xl md:text-5xl font-black text-slate-900">Everything you need to know about QR codes</h1>
              <p className="text-slate-500 font-medium max-w-xl mx-auto">A comprehensive technical and practical guide — from history to implementation.</p>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 md:p-8 space-y-4">
              <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">📖 What is a QR code?</h2>
              <p className="text-slate-500 text-sm leading-relaxed font-medium">QR (Quick Response) code is a two-dimensional barcode invented in 1994 by Denso Wave, a subsidiary of Toyota. Unlike traditional barcodes that store data in one dimension, QR codes store data both horizontally and vertically, allowing them to hold significantly more information — up to 4,296 alphanumeric characters.</p>
              <div className="grid sm:grid-cols-3 gap-4 pt-2">
                {[['4,296', 'Max alphanumeric chars'], ['7,089', 'Max numeric chars'], ['1994', 'Year invented']].map(([n, l]) => (
                  <div key={l} className="bg-slate-50 rounded-xl p-4 text-center border border-slate-100">
                    <div className="text-2xl font-black text-blue-600">{n}</div>
                    <div className="text-xs text-slate-500 font-medium mt-1">{l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 md:p-8 space-y-4">
              <h2 className="text-xl font-black text-slate-900">⚡ Static vs Dynamic QR codes</h2>
              <div className="grid md:grid-cols-2 gap-5">
                {[
                  { type: 'Static QR', icon: '📌', pros: ['No server required — works offline', 'Never expires', 'No ongoing cost', 'Ideal for permanent info (WiFi, vCard, text)', 'Free for all users on QRScoop'], cons: ['Cannot be updated after printing', 'No scan tracking or analytics', 'Larger code for long URLs'], bg: 'slate' },
                  { type: 'Dynamic QR', icon: '🔄', pros: ['Change destination URL anytime', 'Real-time scan analytics', 'Shorter, cleaner QR code', 'A/B test different destinations'], cons: ['Requires active subscription to track', 'QR stops working if the service goes down', 'Free trial expires after 7 days'], bg: 'blue' },
                ].map(c => (
                  <div key={c.type} className={`rounded-xl border p-5 space-y-3 ${c.bg === 'blue' ? 'border-blue-200 bg-blue-50' : 'border-slate-100 bg-slate-50'}`}>
                    <h3 className={`font-black text-lg flex items-center gap-2 ${c.bg === 'blue' ? 'text-blue-900' : 'text-slate-900'}`}>{c.icon} {c.type}</h3>
                    <div><p className="text-xs font-black text-green-700 mb-1.5 uppercase tracking-wide">Pros</p>{c.pros.map(p => <p key={p} className="text-sm text-slate-600 font-medium flex items-start gap-1.5 mb-1"><span className="text-green-500 text-xs mt-0.5 shrink-0">✓</span>{p}</p>)}</div>
                    <div><p className="text-xs font-black text-red-600 mb-1.5 uppercase tracking-wide">Cons</p>{c.cons.map(p => <p key={p} className="text-sm text-slate-600 font-medium flex items-start gap-1.5 mb-1"><span className="text-red-400 text-xs mt-0.5 shrink-0">✕</span>{p}</p>)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-6 md:p-8 space-y-4">
              <h2 className="text-xl font-black text-slate-900">🛡️ Error correction levels explained</h2>
              <p className="text-slate-500 text-sm leading-relaxed font-medium">QR codes use Reed-Solomon error correction, which allows part of the code to be damaged or covered while still being readable.</p>
              <div className="space-y-3">
                {[
                  { l: 'L — Low (7%)', use: 'Clean digital displays with no risk of damage.', best: 'Website QR codes that are only ever shown on screen.' },
                  { l: 'M — Medium (15%)', use: 'Slightly worn paper, mild environmental exposure.', best: 'Flyers, brochures, packaging with minimal wear.' },
                  { l: 'Q — Quartile (25%)', use: 'Codes with small logo embeds.', best: 'Branded codes with a small logo (up to 25% of area).' },
                  { l: 'H — High (30%)', use: 'Maximum recovery. Codes in challenging environments.', best: 'Industrial labels, outdoor posters, codes with prominent logos.' },
                ].map(e => (
                  <div key={e.l} className="bg-slate-50 border border-slate-100 rounded-xl p-4">
                    <p className="font-black text-slate-900 text-sm mb-1">{e.l}</p>
                    <p className="text-slate-500 text-xs font-medium leading-relaxed"><strong>Use when:</strong> {e.use}</p>
                    <p className="text-blue-600 text-xs font-semibold mt-1">Best for: {e.best}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-center">
              <button onClick={() => nav('app')} className="bg-blue-600 hover:bg-blue-700 text-white font-black px-10 py-4 rounded-full shadow-lg shadow-blue-500/25 transition">
                Put it all into practice →
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            PRICING VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'pricing' && (
          <div className="max-w-3xl mx-auto px-4 md:px-8 py-12 md:py-16 space-y-10 text-center">
            <div className="space-y-2">
              <h2 className="text-3xl md:text-4xl font-black text-slate-900">Simple, honest pricing</h2>
              <p className="text-slate-500 font-medium">Start free, upgrade when you need analytics and unlimited dynamic codes.</p>
            </div>
            <div className="flex justify-center gap-6 text-left w-full mx-auto">
              <div className="w-full max-w-sm bg-white border-2 border-blue-600 rounded-2xl shadow-lg p-7 space-y-5 relative">
                <span className="absolute -top-3 right-6 bg-blue-600 text-white font-bold text-[10px] px-3 py-1 rounded-full uppercase tracking-wider">Most Popular</span>
                <div>
                  <h4 className="text-xl font-black text-slate-900">Dynamic Pro</h4>
                  <p className="text-slate-400 text-xs font-medium mt-1">Full tracking & control</p>
                </div>
                <div className="text-4xl font-black text-slate-900">₹199 <span className="text-base text-slate-400 font-normal">/ month</span></div>
                <ul className="space-y-2">
                  {['Unlimited dynamic QR codes', 'Real-time scan analytics', 'Update destination URLs anytime', 'Download count tracking', 'Priority support', 'Unlimited static QR codes'].map(f => (
                    <li key={f} className="flex items-center gap-2 text-sm text-slate-600 font-medium"><span className="text-green-500 text-xs">✓</span>{f}</li>
                  ))}
                </ul>
                <div className="space-y-2 pt-1">
                  <button onClick={() => openRazorpay(false)} className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm transition shadow-lg shadow-blue-500/25">
                    💳 Pay with Card / Netbanking
                  </button>
                  <button onClick={() => openRazorpay(true)} className="w-full py-3 rounded-xl bg-white border-2 border-blue-600 text-blue-600 font-bold text-sm transition hover:bg-blue-50">
                    🇮🇳 Pay via UPI
                  </button>
                  <p className="text-[10px] text-slate-400 text-center font-medium">GPay · PhonePe · Paytm · BHIM · All UPI apps</p>
                </div>
              </div>
            </div>
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden text-sm">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left py-3 px-5 font-black text-slate-700">Feature</th>
                  <th className="py-3 px-4 font-black text-slate-700">Free</th>
                  <th className="py-3 px-4 font-black text-blue-700">Pro</th>
                </tr></thead>
                <tbody>
                  {[
                    ['Static QR codes', 'Unlimited ✅', 'Unlimited ✅'],
                    ['Dynamic QR codes', '2 (7-day trial)', 'Unlimited'],
                    ['Design customization', '✅', '✅'],
                    ['Logo embedding', '✅', '✅'],
                    ['PNG & SVG export', '✅', '✅'],
                    ['Scan analytics', '❌', '✅'],
                    ['Update destination URL', '❌', '✅'],
                    ['Download tracking', '❌', '✅'],
                  ].map(([f, fr, pro]) => (
                    <tr key={f} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-3 px-5 text-slate-600 font-medium">{f}</td>
                      <td className="py-3 px-4 text-center text-slate-500">{fr}</td>
                      <td className="py-3 px-4 text-center text-blue-600 font-semibold">{pro}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            LOGIN VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'login' && (
          <div className="max-w-md mx-auto px-4 py-12">
            <div className="bg-white border border-slate-100 rounded-3xl shadow-xl p-8 space-y-6">
              <div className="text-center space-y-1">
                <h2 className="text-2xl font-black text-slate-900">{isSignUp ? 'Create account' : 'Welcome back'}</h2>
                <p className="text-slate-400 text-sm font-medium">Manage your QR codes and analytics.</p>
              </div>
              <form onSubmit={handleAuthSubmit} className="space-y-4">
                {isSignUp && (
                  <div className="space-y-1">
                    <span className="text-xs font-bold text-slate-500">Full name</span>
                    <input type="text" required placeholder="Alex Mercer" value={authForm.name}
                      onChange={e => setAuthForm({ ...authForm, name: e.target.value })}
                      className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 text-sm font-medium" />
                  </div>
                )}
                <div className="space-y-1">
                  <span className="text-xs font-bold text-slate-500">Email address</span>
                  <input type="email" required placeholder="name@domain.com" value={authForm.email}
                    onChange={e => setAuthForm({ ...authForm, email: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 text-sm font-medium" />
                </div>
                <div className="space-y-1">
                  <span className="text-xs font-bold text-slate-500">Password</span>
                  <input type="password" required placeholder="••••••••" value={authForm.password}
                    onChange={e => setAuthForm({ ...authForm, password: e.target.value })}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 text-sm font-medium" />
                </div>
                <button
                  type="button"
                  onClick={handleGoogleOAuth}
                  className="w-full flex items-center justify-center gap-3 bg-white border-2 border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 font-bold py-3 rounded-xl text-sm transition shadow-sm"
                >
                  <img src="https://www.svgrepo.com/show/475656/google-color.svg" alt="Google" className="w-5 h-5" />
                  Continue with Google
                </button>
                <div className="flex items-center gap-4 my-1">
                  <div className="flex-1 h-px bg-slate-200"></div>
                  <span className="text-xs font-bold text-slate-400 uppercase">Or use email</span>
                  <div className="flex-1 h-px bg-slate-200"></div>
                </div>
                <button type="submit" disabled={authLoading}
                  className="w-full bg-slate-900 hover:bg-slate-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl text-sm transition shadow mt-1">
                  {authLoading ? 'Please wait…' : isSignUp ? 'Create Account' : 'Sign In'}
                </button>
              </form>
              <p className="text-center text-xs font-bold text-slate-400">
                {isSignUp ? 'Already have an account?' : 'New here?'}
                <button onClick={() => setIsSignUp(!isSignUp)} className="text-blue-600 font-bold hover:underline ml-1 bg-transparent border-none cursor-pointer">
                  {isSignUp ? 'Sign In' : 'Create account'}
                </button>
              </p>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            DASHBOARD VIEW
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'dashboard' && userId && (
          <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-6">
            {/* Profile block */}
            <div className="bg-white border border-slate-100 rounded-3xl shadow-sm p-6 flex flex-col sm:flex-row items-center gap-6">
              <div className="h-16 w-16 rounded-full bg-slate-100 border overflow-hidden flex items-center justify-center shadow-sm">
                {userProfile.avatar ? (
                  <img src={userProfile.avatar} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-2xl text-slate-400 font-black">
                    {(userProfile.name || session?.user?.email || '?').charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="text-center sm:text-left space-y-0.5 flex-1">
                <h3 className="text-xl font-black text-slate-900 capitalize">{userProfile.name || 'User'}</h3>
                <p className="text-xs font-medium text-slate-400">{userProfile.email}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${isPremium ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-slate-100 text-slate-500'}`}>
                    {isPremium ? '👑 Pro' : 'Free Plan'}
                  </span>
                  {isPremium && premiumUntil && (
                    <span className="text-[10px] font-bold text-slate-400">
                      Valid until {new Date(premiumUntil).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2.5">
                <button onClick={() => nav('app')} className="bg-blue-600 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition hover:bg-blue-700 shadow">
                  Go to Generator
                </button>
                <button onClick={handleLogout} className="bg-red-50 text-red-600 hover:bg-red-100 font-bold px-5 py-2.5 rounded-xl text-sm transition border border-red-100">
                  Log Out
                </button>
              </div>
            </div>

            {/* ── CUSTOM LANDING PAGES MANAGER ── */}
            <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-black text-slate-900 text-lg flex items-center gap-2">
                    <span>📱</span> Custom Landing Pages
                  </h3>
                  <p className="text-slate-400 text-xs font-medium mt-0.5">
                    Mobile-first bio-link and business menu pages hosted under <code>/p/:slug</code>
                  </p>
                </div>
                <button
                  onClick={() => handleOpenLandingModal(null)}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2.5 rounded-xl transition shadow flex items-center gap-2 w-fit"
                >
                  <span>+</span> Create Landing Page
                </button>
              </div>

              <div className="p-6">
                {userLandingPages.length > 0 ? (
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {userLandingPages.map((page) => (
                      <div
                        key={page.id}
                        className="bg-slate-50 border border-slate-200/80 rounded-2xl p-5 flex flex-col justify-between hover:shadow-sm transition"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-md">
                              /p/{page.slug}
                            </span>
                            <span className="text-[10px] text-slate-400 font-semibold">
                              {Array.isArray(page.links) ? page.links.length : 0} links
                            </span>
                          </div>
                          <h4 className="font-black text-slate-900 text-base truncate" title={page.title}>
                            {page.title}
                          </h4>
                          {page.bio && (
                            <p className="text-xs text-slate-500 font-medium line-clamp-2 leading-relaxed">
                              {page.bio}
                            </p>
                          )}
                        </div>

                        <div className="pt-4 mt-4 border-t border-slate-200 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <a
                              href={`/p/${page.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs font-bold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition"
                            >
                              Visit ↗
                            </a>
                            <button
                              onClick={() => handleGenerateLandingQr(page.slug)}
                              className="text-xs font-bold text-blue-600 hover:text-blue-800 bg-blue-50 border border-blue-100 px-2.5 py-1.5 rounded-lg transition"
                            >
                              Get QR
                            </button>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOpenLandingModal(page)}
                              className="text-xs p-1.5 hover:bg-white rounded-lg transition"
                            >
                              ✏️
                            </button>
                            <button
                              onClick={() => handleDeleteLandingPage(page.id)}
                              className="text-xs p-1.5 hover:bg-red-50 rounded-lg transition text-red-500"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-10 space-y-3">
                    <span className="text-4xl text-slate-200">📑</span>
                    <p className="text-slate-500 text-xs font-medium max-w-sm mx-auto">
                      You haven't built any landing pages yet. Create one to share multiple social links, menus, or contact details behind a single QR code.
                    </p>
                    <button
                      onClick={() => handleOpenLandingModal(null)}
                      className="text-blue-600 font-bold text-xs hover:underline"
                    >
                      + Create your first page
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* QR codes table / lock screen */}
            {isPremium ? (
              <div className="bg-white border border-slate-100 rounded-3xl shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="font-black text-slate-900 text-lg">Generated QR Codes</h3>
                  <span className="text-xs font-bold text-slate-400 bg-slate-50 px-2.5 py-1 rounded-full border border-slate-100">{dashData.length} total</span>
                </div>
                <div className="p-6">
                  {dashLoading ? (
                    <div className="text-center text-slate-400 text-sm font-bold py-12">Loading analytics…</div>
                  ) : dashData.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-xs font-black text-slate-400 uppercase tracking-wider border-b border-slate-100">
                            <th className="pb-3 px-2">Code</th>
                            <th className="pb-3 px-2">Type</th>
                            <th className="pb-3 px-2 hidden md:table-cell">Destination</th>
                            <th className="pb-3 px-2">Scans</th>
                            <th className="pb-3 px-2">Downloads</th>
                            <th className="pb-3 px-2">QR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dashData.map((qr, i) => (
                            <tr key={i} className="border-b border-slate-50 hover:bg-blue-50/30 transition group">
                              <td className="py-4 px-2 font-mono text-sm font-bold text-blue-600">{qr.short_code}</td>
                              <td className="py-4 px-2">
                                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${qr.qr_type === 'dynamic' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                                  {qr.qr_type}
                                </span>
                                <span className="ml-1.5 text-[11px] text-slate-400 font-medium capitalize">{qr.content_type}</span>
                              </td>
                              <td className="py-4 px-2 hidden md:table-cell max-w-[200px]">
                                <span className="text-xs text-slate-400 font-medium truncate block" title={qr.target_url}>
                                  {qr.target_url?.length > 35 ? qr.target_url.slice(0, 35) + '…' : qr.target_url}
                                </span>
                              </td>
                              <td className="py-4 px-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-black text-slate-900">{qr.clicks || 0}</span>
                                  {qr.qr_type === 'static' && <span className="text-[9px] text-slate-300 font-bold">—</span>}
                                </div>
                              </td>
                              <td className="py-4 px-2"><span className="text-sm font-black text-slate-900">{qr.downloads || 0}</span></td>
                              <td className="py-4 px-2">
                                <button onClick={() => setViewQr(qr)}
                                  className="flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition border border-blue-100">
                                  View QR
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-center py-16 space-y-3">
                      <span className="text-4xl text-slate-200">📭</span>
                      <p className="text-slate-500 text-sm font-medium">No QR codes yet.</p>
                      <button onClick={() => nav('app')} className="text-blue-600 font-bold text-sm hover:underline">Generate your first code →</button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white border border-slate-100 rounded-3xl shadow-sm p-12 flex flex-col items-center justify-center text-center space-y-4">
                <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center text-4xl shadow-inner border border-blue-100">🔒</div>
                <h3 className="text-2xl font-black text-slate-900">Analytics Locked</h3>
                <p className="text-slate-500 font-medium max-w-md leading-relaxed">
                  Your generated QR codes and live tracking analytics are safely stored. Upgrade to Pro to access and manage them.
                </p>
                <button onClick={() => openRazorpay(false)} className="mt-4 bg-blue-600 text-white font-black px-8 py-3.5 rounded-xl shadow-lg shadow-blue-500/25 hover:bg-blue-700 transition">
                  👑 Upgrade to Unlock
                </button>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            LEGAL PAGES
        ═══════════════════════════════════════════════════════════════════ */}
        {(view === 'tos' || view === 'privacy' || view === 'refund') && (
          <div className="w-full max-w-3xl mx-auto py-12 md:py-16">
            <div className="bg-white border border-slate-100 p-8 md:p-12 rounded-3xl shadow-sm space-y-8">
              {view === 'tos' && (
                <>
                  <div className="space-y-2 border-b border-slate-100 pb-6">
                    <h1 className="text-3xl font-black text-slate-900">Terms of Service</h1>
                    <p className="text-sm font-medium text-slate-500">Last updated: {new Date().toLocaleDateString()}</p>
                  </div>
                  <div className="prose prose-slate prose-sm md:prose-base space-y-6 text-slate-600 font-medium leading-relaxed">
                    <p><strong>Welcome to QRScoop.</strong> By using our website and services, you agree to these terms.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Acceptable Use</h3>
                    <p>You agree not to use QRScoop to generate QR codes that redirect to malicious, illegal, explicit, or phishing websites. We reserve the right to suspend or terminate accounts and disable any dynamic links that violate this policy.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Service Availability</h3>
                    <p>While we strive for maximum uptime for our dynamic routing infrastructure, QRScoop is provided "as is." We are not liable for any losses incurred if a dynamic link is temporarily unavailable.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Account Security</h3>
                    <p>You are responsible for maintaining the security of your account credentials. You must notify us immediately of any unauthorized access to your dashboard.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Subscription & Payments</h3>
                    <p>Paid plans are billed in advance. You can cancel your subscription at any time, but your premium routing features will remain active until the end of your current billing cycle.</p>
                  </div>
                </>
              )}
              {view === 'privacy' && (
                <>
                  <div className="space-y-2 border-b border-slate-100 pb-6">
                    <h1 className="text-3xl font-black text-slate-900">Privacy Policy</h1>
                    <p className="text-sm font-medium text-slate-500">Last updated: {new Date().toLocaleDateString()}</p>
                  </div>
                  <div className="prose prose-slate prose-sm md:prose-base space-y-6 text-slate-600 font-medium leading-relaxed">
                    <p><strong>Your Privacy at QRScoop.</strong> We respect your privacy and are committed to protecting the data of both our developers and their end-users.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Information We Collect from You</h3>
                    <p>When you register, we collect your name and email address. If you upgrade to Pro, your payment information is processed directly by Razorpay; we do not store your credit card details on our servers.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Information We Collect via QR Scans</h3>
                    <p>When end-users scan your Dynamic QR codes, our routing system logs anonymous analytic data, such as the timestamp of the scan. We do not collect personally identifiable information from the people scanning your codes.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Third-Party Services</h3>
                    <p>We utilize secure third-party infrastructure for database hosting and payment processing. Your data is never sold to third parties or data brokers.</p>
                  </div>
                </>
              )}
              {view === 'refund' && (
                <>
                  <div className="space-y-2 border-b border-slate-100 pb-6">
                    <h1 className="text-3xl font-black text-slate-900">Refund Policy</h1>
                    <p className="text-sm font-medium text-slate-500">Last updated: {new Date().toLocaleDateString()}</p>
                  </div>
                  <div className="prose prose-slate prose-sm md:prose-base space-y-6 text-slate-600 font-medium leading-relaxed">
                    <h3 className="text-slate-900 font-bold text-lg">Digital Goods</h3>
                    <p>Because QRScoop provides immediate access to digital generation tools and active routing node allocation, we generally do not offer refunds once a Pro subscription is activated and dynamic codes have been generated.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Free Tier Evaluation</h3>
                    <p>We provide a fully functional free tier for Static QR codes so you can test our generation engine before committing to a paid plan. We encourage all users to utilize this free tier to ensure the service meets their needs.</p>
                    <h3 className="text-slate-900 font-bold text-lg mt-6">Billing Errors</h3>
                    <p>If you believe you were billed in error or experienced a critical system failure during your transaction, please contact our support team within 7 days of the charge for a manual review.</p>
                  </div>
                </>
              )}
              
              <div className="pt-8 text-center border-t border-slate-100">
                <button onClick={() => nav('landing')} className="text-blue-600 font-bold hover:underline cursor-pointer">← Return to Home</button>
              </div>
            </div>
          </div>
        )}

        {/* ── CONTACT US (PASTE DIRECTLY HERE) ── */}
        {view === 'contact' && (
          <div className="max-w-md mx-auto px-4 py-12 md:py-16 space-y-8">
            <div className="text-center space-y-3">
              <span className="inline-block px-3 py-1 bg-pink-50 text-pink-600 text-xs font-bold rounded-full border border-pink-100">
                Get In Touch
              </span>
              <h1 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight">
                Contact Us
              </h1>
              <p className="text-slate-500 font-medium text-sm leading-relaxed">
                Have questions, suggestions, or need custom support? Reach out directly via Instagram DM.
              </p>
            </div>

            <div className="bg-white border border-slate-100 rounded-3xl shadow-sm hover:shadow-md transition p-8 text-center space-y-5">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-pink-500/20">
                <svg className="w-8 h-8 fill-current" viewBox="0 0 24 24">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                </svg>
              </div>

              <div>
                <h3 className="font-black text-slate-900 text-lg">Instagram DM</h3>
                <p className="text-xs font-bold text-pink-600 mt-0.5">@qrscoop</p>
                <p className="text-xs text-slate-500 font-medium mt-2 leading-relaxed">
                  Fastest response for account queries, custom plans, and feature requests.
                </p>
              </div>

              <a
                href="https://www.instagram.com/qrscoop_official/"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-gradient-to-r from-purple-600 via-rose-500 to-amber-500 hover:opacity-95 text-white font-bold text-sm shadow-md shadow-pink-500/20 transition"
              >
                <span>Message on Instagram</span>
                <span>↗</span>
              </a>
            </div>

            <div className="text-center">
              <button
                onClick={() => nav('app')}
                className="text-xs font-bold text-slate-400 hover:text-slate-600 transition"
              >
                ← Back to QR Generator
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            PUBLIC CUSTOM LANDING PAGE VIEW (/p/:slug)
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'public-landing' && (
          <div className="min-h-[75vh] flex items-center justify-center px-4 py-10">
            {landingLoading ? (
              <div className="text-center space-y-3">
                <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-sm font-bold text-slate-500">Loading page...</p>
              </div>
            ) : landingError ? (
              <div className="max-w-md w-full bg-white border border-slate-100 rounded-3xl p-8 text-center space-y-4 shadow-sm">
                <span className="text-5xl">🔍</span>
                <h2 className="text-2xl font-black text-slate-900">Page Not Found</h2>
                <p className="text-xs text-slate-500 leading-relaxed font-medium">
                  {landingError}
                </p>
                <button
                  onClick={() => nav('landing')}
                  className="px-6 py-2.5 bg-blue-600 text-white font-bold rounded-xl text-xs hover:bg-blue-700 transition"
                >
                  Create Your Own on QRScoop
                </button>
              </div>
            ) : landingData ? (
              <div className="max-w-md w-full bg-white border border-slate-100 rounded-3xl shadow-xl p-6 sm:p-8 space-y-6 text-center">
                {/* Profile Header */}
                <div className="space-y-3 flex flex-col items-center">
                  <div className="w-24 h-24 rounded-full overflow-hidden bg-slate-100 border-2 border-white shadow-md flex items-center justify-center">
                    {landingData.avatar_url ? (
                      <img
                        src={landingData.avatar_url}
                        alt={landingData.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-3xl font-black text-slate-400">
                        {landingData.title?.charAt(0)?.toUpperCase() || 'Q'}
                      </span>
                    )}
                  </div>
                  <div>
                    <h1 className="text-2xl font-black text-slate-900 tracking-tight">
                      {landingData.title}
                    </h1>
                    {landingData.bio && (
                      <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed max-w-xs mx-auto">
                        {landingData.bio}
                      </p>
                    )}
                  </div>
                </div>

                {/* Custom Links & Pro Social Embeds */}
                <div className="space-y-3">
                  {(() => {
                    let linksList = [];
                    try {
                      linksList = typeof landingData.links === 'string'
                        ? JSON.parse(landingData.links || '[]')
                        : (Array.isArray(landingData.links) ? landingData.links : []);
                    } catch {
                      linksList = [];
                    }

                    if (linksList.length === 0) {
                      return <p className="text-xs text-slate-400 font-medium">No links added yet.</p>;
                    }

                    return linksList.map((link, idx) => {
                      // Check for YouTube Embed (e.g., youtube.com/watch?v=XYZ or youtu.be/XYZ)
                      const ytMatch = link.url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
                      const isYouTube = Boolean(ytMatch && ytMatch[1]);

                      if (isYouTube) {
                        const videoId = ytMatch[1];
                        return (
                          <div key={idx} className="space-y-1.5 text-left">
                            {link.title && (
                              <p className="text-xs font-bold text-slate-700 px-1">{link.title}</p>
                            )}
                            <div className="relative w-full aspect-video rounded-2xl overflow-hidden shadow-sm border border-slate-100 bg-black">
                              <iframe
                                src={`https://www.youtube-nocookie.com/embed/${videoId}`}
                                title={link.title || 'YouTube video'}
                                className="w-full h-full"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                              />
                            </div>
                          </div>
                        );
                      }

                      // Standard Link Button
                      return (
                        <a
                          key={idx}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block w-full py-3.5 px-5 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-2xl font-bold text-slate-800 hover:text-blue-700 text-sm transition shadow-sm hover:shadow"
                        >
                          {link.title || link.url}
                        </a>
                      );
                    });
                  })()}
                </div>

                {/* Footer attribution */}
                <div className="pt-4 border-t border-slate-100 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-400">
                  <span>Powered by</span>
                  <button
                    onClick={() => nav('landing')}
                    className="font-bold text-blue-600 hover:underline"
                  >
                    QRScoop
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            BULK CSV GENERATOR VIEW (PRO FEATURE)
        ═══════════════════════════════════════════════════════════════════ */}
        {view === 'bulk' && (
          <div className="max-w-5xl mx-auto px-4 md:px-8 py-10 md:py-14 space-y-8">
            <div className="text-center space-y-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                👑 Pro Feature
              </span>
              <h1 className="text-3xl md:text-5xl font-black text-slate-900 tracking-tight">
                Bulk CSV QR Generator
              </h1>
              <p className="text-slate-500 font-medium max-w-xl mx-auto text-sm md:text-base">
                Batch generate hundreds of high-resolution QR codes in seconds. Customized with your active styling, packaged cleanly into a `.zip` file.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              {/* Left Column: Upload & Options */}
              <div className="md:col-span-2 bg-white border border-slate-100 rounded-3xl p-6 md:p-8 shadow-sm space-y-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <h3 className="text-base font-black text-slate-900">Upload Spreadsheet (.CSV)</h3>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleDownloadSampleCsv}
                      className="text-xs font-bold text-blue-600 hover:text-blue-700 transition underline"
                    >
                      Sample URL CSV
                    </button>
                    <span className="text-slate-300">•</span>
                    <button
                      onClick={handleDownloadSampleUpiCsv}
                      className="text-xs font-bold text-emerald-600 hover:text-emerald-700 transition underline flex items-center gap-1"
                    >
                      <span>🇮🇳</span> Sample UPI CSV
                    </button>
                  </div>
                </div>

                <label className="flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed border-slate-200 rounded-2xl cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition">
                  <span className="text-4xl">📄</span>
                  <div className="text-center">
                    <p className="text-sm font-bold text-slate-700">
                      {csvFileName ? csvFileName : 'Click to upload your CSV file'}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      Accepts standard <code>url</code> or <code>upi_id, payee, amount, note</code>
                    </p>
                  </div>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleCsvUpload}
                  />
                </label>

                {/* Data Preview */}
                {csvData.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-500">
                      <span>Preview ({csvData.length} records detected)</span>
                      {!isPremium && csvData.length > 3 && (
                        <span className="text-amber-600">Free limit: 3 codes. Upgrade for all {csvData.length}.</span>
                      )}
                    </div>

                    <div className="max-h-48 overflow-y-auto border border-slate-100 rounded-xl bg-slate-50 p-2 text-xs font-mono">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-400">
                            <th className="p-1.5">#</th>
                            <th className="p-1.5">Filename</th>
                            <th className="p-1.5">Destination URL / Content</th>
                          </tr>
                        </thead>
                        <tbody>
                          {csvData.slice(0, 5).map((row, idx) => (
                            <tr key={idx} className="border-b border-slate-100 last:border-none">
                              <td className="p-1.5 text-slate-400">{idx + 1}</td>
                              <td className="p-1.5 font-bold text-slate-700">{row.filename || row.name || `qr-${idx + 1}`}</td>
                              <td className="p-1.5 text-slate-500 truncate max-w-[200px]">
                                {row.url || row.link || row.data || (
                                  (row.upi_id || row.vpa) ? (
                                    <span className="text-emerald-700 font-semibold">
                                      {row.upi_id || row.vpa}
                                      {row.amount ? ` (₹${row.amount})` : ''}
                                    </span>
                                  ) : '—'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {csvData.length > 5 && (
                        <p className="text-[10px] text-center text-slate-400 py-1.5">+ {csvData.length - 5} more records</p>
                      )}
                    </div>

                    {/* Progress Bar */}
                    {isBulkProcessing && (
                      <div className="space-y-1.5 pt-2">
                        <div className="flex justify-between text-xs font-bold text-slate-600">
                          <span>Rendering codes in browser...</span>
                          <span>{bulkProgress}%</span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all duration-200"
                            style={{ width: `${bulkProgress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Action Button */}
                    <button
                      onClick={handleGenerateBulkZip}
                      disabled={isBulkProcessing}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-blue-500/25 transition text-sm flex items-center justify-center gap-2"
                    >
                      {isBulkProcessing
                        ? 'Packaging ZIP Archive...'
                        : !isPremium && csvData.length > 3
                        ? '👑 Unlock Full Batch with Pro'
                        : `⬇️ Generate & Download ${csvData.length} QR Codes (.ZIP)`}
                    </button>
                  </div>
                )}
              </div>

              {/* Right Column: Active Styles & Pro Perks */}
              <div className="space-y-5">
                <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm space-y-4">
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider">Applied Design</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Bulk codes automatically inherit your configured dot styles, palette, and center logo from the Generator tab.
                  </p>
                  <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Dot Shape:</span>
                      <span className="font-bold text-slate-700 capitalize">{dotStyle}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Background:</span>
                      <span className="font-bold text-slate-700">{bgTransparent ? 'Transparent' : bgColor}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Error Correction:</span>
                      <span className="font-bold text-blue-600">Level {errorLevel}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => nav('app')}
                    className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
                  >
                    Adjust Styles in Designer →
                  </button>
                </div>

                <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-3xl p-6 text-white space-y-3 shadow-md">
                  <span className="text-2xl">⚡</span>
                  <h4 className="font-black text-base">Client-Side Speed</h4>
                  <p className="text-slate-300 text-xs leading-relaxed font-medium">
                    All generation occurs directly on your device using Web Workers and HTML Canvas. Your customer links and lists are never uploaded or stored on any server.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════
            QR PREVIEW MODAL (Dashboard)
        ═══════════════════════════════════════════════════════════════════ */}
        {viewQr && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setViewQr(null); }}>
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-black text-slate-900 text-lg">QR Code Preview</h3>
                  <p className="text-slate-400 text-xs font-medium mt-0.5">
                    <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono text-blue-600">{viewQr.short_code}</code>
                    <span className={`ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full ${viewQr.qr_type === 'dynamic' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                      {viewQr.qr_type}
                    </span>
                  </p>
                </div>
                <button onClick={() => setViewQr(null)} className="text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 transition text-lg font-black shrink-0">✕</button>
              </div>

              <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-2xl p-5 flex items-center justify-center min-h-[200px]">
                <div ref={modalCanvasRef} className="flex items-center justify-center" />
              </div>

              <div className="bg-slate-50 rounded-xl border border-slate-100 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-400">Encodes</span>
                  {/* FIX: static QRs encode target_url directly, not the redirect URL */}
                  <span className="font-bold text-slate-700 text-right max-w-[220px] truncate">
                    {(viewQr.qr_type === 'dynamic' && viewQr.content_type === 'link')
                      ? `${BACKEND_URL}/r/${viewQr.short_code}`
                      : viewQr.target_url}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-400">Destination</span>
                  <span className="font-medium text-slate-600 text-right max-w-[220px] truncate">{viewQr.target_url}</span>
                </div>
                <div className="flex items-center gap-4 pt-1 text-xs font-bold text-slate-500">
                  {viewQr.qr_type === 'dynamic'
                    ? <><span>👁 {viewQr.clicks || 0} scans</span><span>⬇️ {viewQr.downloads || 0} downloads</span></>
                    : <span className="text-slate-400 text-[11px]">📄 Static — no click tracking</span>
                  }
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    modalQrRef.current?.download({ name: `qrscoop-${viewQr.short_code}`, extension: 'png' });
                    if (viewQr.qr_type === 'dynamic' && session) {
                      fetch(`${BACKEND_URL}/api/qr/log-download`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                        body: JSON.stringify({ shortCode: viewQr.short_code }),
                      }).catch(() => { });
                    }
                  }}
                  className="bg-slate-900 hover:bg-slate-700 text-white font-bold py-3 rounded-xl text-xs transition shadow"
                >
                  ⬇️ Download PNG
                </button>
                <button
                  onClick={() => modalQrRef.current?.download({ name: `qrscoop-${viewQr.short_code}`, extension: 'svg' })}
                  className="bg-white hover:bg-slate-50 text-slate-900 font-bold py-3 rounded-xl text-xs transition shadow border border-slate-200"
                >
                  ⬇️ Download SVG
                </button>
              </div>

              {viewQr.qr_type === 'dynamic' && (
                <p className="text-[10px] text-center text-slate-400 font-medium -mt-1">
                  Dynamic QR — redirects through your server to <strong>{viewQr.target_url?.slice(0, 40)}{viewQr.target_url?.length > 40 ? '…' : ''}</strong>
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── LANDING PAGE CREATOR MODAL ── */}
        {showLandingModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowLandingModal(false); }}
          >
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6 sm:p-8 space-y-5 max-h-[90vh] overflow-y-auto">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-black text-slate-900 text-xl">
                    {landingForm.id ? 'Edit Landing Page' : 'Create Custom Landing Page'}
                  </h3>
                  <p className="text-slate-400 text-xs font-medium mt-0.5">
                    Accessible at <code>{window.location.host}/p/{landingForm.slug || ':slug'}</code>
                  </p>
                </div>
                <button
                  onClick={() => setShowLandingModal(false)}
                  className="text-slate-400 hover:text-slate-700 text-lg font-black"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleSaveLandingPage} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    URL Slug * (Unique)
                  </label>
                  <div className="flex items-center bg-slate-50 border border-slate-200 rounded-xl px-3 focus-within:border-blue-500">
                    <span className="text-xs font-bold text-slate-400 select-none">
                      {window.location.host}/p/
                    </span>
                    <input
                      type="text"
                      required
                      placeholder="royal-cafe"
                      value={landingForm.slug}
                      onChange={(e) =>
                        setLandingForm({
                          ...landingForm,
                          slug: slugify(e.target.value),
                        })
                      }
                      className="w-full py-2.5 px-1 bg-transparent text-xs font-mono font-bold text-slate-800 focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Page Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="Royal Cafe & Bakery"
                    value={landingForm.title}
                    onChange={(e) => {
                      const newTitle = e.target.value;
                      setLandingForm((prev) => ({
                        ...prev,
                        title: newTitle,
                        // Only auto-generate slug for new pages if the user hasn't manually customized it
                        slug: prev.id ? prev.slug : slugify(newTitle),
                      }));
                    }}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Short Bio</label>
                  <textarea
                    rows={2}
                    placeholder="Artisan coffees and fresh bakery items."
                    value={landingForm.bio}
                    onChange={(e) => setLandingForm({ ...landingForm, bio: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500 resize-none"
                  />
                </div>

                {/* Dynamic Links Section */}
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-bold text-slate-700">Links & Embeds</label>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isPremium
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-slate-100 text-slate-600'
                        }`}>
                        {isPremium ? '👑 Pro: Unlimited' : `${landingForm.links.length}/1 Link (Free)`}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={handleAddLinkRow}
                      className="text-xs font-bold text-blue-600 hover:text-blue-700 transition flex items-center gap-1"
                    >
                      <span>+ Add Link</span>
                      {!isPremium && landingForm.links.length >= 1 && (
                        <span className="text-[9px] bg-amber-500 text-white font-black px-1.5 py-0.2 rounded">
                          PRO
                        </span>
                      )}
                    </button>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {landingForm.links.map((link, idx) => (
                      <div key={link.id || idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Label (e.g. Menu, Instagram)"
                          value={link.title}
                          onChange={(e) => handleUpdateLinkRow(link.id, 'title', e.target.value)}
                          className="w-1/3 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="text"
                          placeholder="https://..."
                          value={link.url}
                          onChange={(e) => handleUpdateLinkRow(link.id, 'url', e.target.value)}
                          className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500"
                        />
                        {landingForm.links.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLinkRow(link.id)}
                            className="text-slate-400 hover:text-red-500 p-1.5 text-sm font-bold"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {!isPremium && (
                    <p className="text-[11px] text-slate-400 pt-1">
                      💡 <strong>Pro Tip:</strong> Upgrade to add unlimited buttons and embed YouTube videos directly on your page.
                    </p>
                  )}
                </div>

                <div className="pt-3 flex gap-2">
                  <button
                    type="submit"
                    disabled={landingModalLoading}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl text-xs transition shadow-md"
                  >
                    {landingModalLoading ? 'Saving...' : landingForm.id ? 'Save Changes' : 'Publish Landing Page'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowLandingModal(false)}
                    className="px-5 py-3 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-xs font-bold transition"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </main>

      {/* GLOBAL FOOTER */}
      <footer className="w-full border-t border-slate-100 bg-white py-8 md:py-12 mt-auto">
        <div className="max-w-6xl mx-auto px-6 md:px-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center space-x-2 text-slate-900 font-black">
            <div className="h-6 w-6 rounded bg-blue-600 flex items-center justify-center text-white text-xs">Q</div>
            <span>QRScoop</span>
          </div>
          <div className="flex flex-wrap justify-center gap-6 text-sm font-bold text-slate-500">
            <button onClick={() => { nav('contact'); window.scrollTo(0, 0); }} className="hover:text-blue-600 transition cursor-pointer">Contact Us</button>
            <button onClick={() => { nav('tos');     window.scrollTo(0, 0); }} className="hover:text-blue-600 transition cursor-pointer">Terms of Service</button>
            <button onClick={() => { nav('privacy'); window.scrollTo(0, 0); }} className="hover:text-blue-600 transition cursor-pointer">Privacy Policy</button>
            <button onClick={() => { nav('refund');  window.scrollTo(0, 0); }} className="hover:text-blue-600 transition cursor-pointer">Refund Policy</button>
          </div>
          <div className="text-xs font-medium text-slate-400">
            © {new Date().getFullYear()} QRScoop. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
