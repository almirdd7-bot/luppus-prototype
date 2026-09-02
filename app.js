        const WIPE_PIN = "outdd102030";

        // Escapa texto digitado pelo usuário (descrição, categoria, nome de documento)
        // antes de injetar via innerHTML, prevenindo XSS armazenado.
        function escapeHtml(str) {
            if(str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // Projeto oficial do LUPPUS (login real de empresa/cliente) — a apiKey do Firebase
        // é feita para ficar pública no front-end; a segurança de verdade vem das regras do Firestore.
        const PROD_FIREBASE_CONFIG = {
            apiKey: "AIzaSyCPAhfD76uE0eLDtfAZqTW4VjNBv9t8lj4",
            authDomain: "luppus-painel-financeiro.firebaseapp.com",
            projectId: "luppus-painel-financeiro",
            storageBucket: "luppus-painel-financeiro.firebasestorage.app",
            messagingSenderId: "99405704707",
            appId: "1:99405704707:web:b321517e43cdce495ba836",
            measurementId: "G-TEZMYK7TGC"
        };
        const AUTH_APP_NAME = 'luppusAuth';

        function getAuthApp() {
            const existing = firebase.apps.find(a => a.name === AUTH_APP_NAME);
            return existing || firebase.initializeApp(PROD_FIREBASE_CONFIG, AUTH_APP_NAME);
        }

        function translateAuthError(code) {
            const map = {
                'auth/invalid-email': 'E-mail inválido.',
                'auth/user-disabled': 'Esta conta foi desativada.',
                'auth/user-not-found': 'E-mail ou senha incorretos.',
                'auth/wrong-password': 'E-mail ou senha incorretos.',
                'auth/invalid-credential': 'E-mail ou senha incorretos.',
                'auth/too-many-requests': 'Muitas tentativas. Aguarde um momento e tente novamente.',
                'auth/email-already-in-use': 'Já existe uma conta com este e-mail.',
                'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
                'auth/network-request-failed': 'Falha de conexão. Verifique sua internet.'
            };
            return map[code] || 'Não foi possível completar a operação. Tente novamente.';
        }

        let appDB = {
            companies: [{ id: "default", name: "DADOS DA EMPRESA", info: "Luppus API" }],
            currentCompanyId: "default",
            transactions: { "default": [] },
            spreadsheets: {},
            spreadsheetActiveId: {},
            vault: {}
        };

        let chartInstance = null;
        let biChartInstance = null;
        let forecastChartInstance = null;
        let forecastCategoryChartInstance = null;
        let categoryChartInstance = null;
        let cloudDB = null;
        let currentDocId = 'node_state'; // vira o UID de cada conta autenticada — ver initFirebase()
        let pendingOFX = [];
        let filterTimeout;

        let mySpreadsheet = null;
        let biData = [];
        let biHeaders = [];
        let biDrilldownFilter = null;
        let spreadsheetUndoStash = {};
        let spreadsheetHistory = {}; // { sheetId: [{data, savedAt, savedBy}, ...] } — últimas 5 versões salvas

        function cssVar(name) {
            return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        }

        function cssVarAlpha(name, alpha) {
            const hex = cssVar(name).replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        function categoricalPalette(n) {
            const base = ['--champagne', '--success', '--danger', '--text-muted'];
            const colors = [];
            for (let i = 0; i < n; i++) {
                const alpha = i < base.length ? 0.75 : 0.4;
                colors.push(cssVarAlpha(base[i % base.length], alpha));
            }
            return colors;
        }

        function verticalGradient(ctx, name, height, topAlpha, bottomAlpha) {
            const hex = cssVar(name).replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const grad = ctx.createLinearGradient(0, 0, 0, height);
            grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${topAlpha})`);
            grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${bottomAlpha})`);
            return grad;
        }
        
        let isClientMode = false;
        let userRole = 'empresa'; // 'cliente' | 'empresa' | 'dev' — controla quais abas de Configurações aparecem
        let appEntered = false;

        // --- TRILHA DE AUDITORIA ---
        // Quem fez a ação, agora — usado no log e em qualquer relatório que precise identificar o autor.
        function getCurrentUserLabel() {
            try {
                const authApp = firebase.apps.find(a => a.name === AUTH_APP_NAME);
                const u = authApp && authApp.auth().currentUser;
                return (u && u.email) || 'demo';
            } catch(e) { return 'desconhecido'; }
        }

        // Registro append-only de criação/edição/exclusão — nunca é reescrito, só recebe novas entradas.
        // Cada entrada guarda o valor antes/depois para permitir reconstituir o que mudou.
        function logAudit(entity, action, entityLabel, before, after) {
            if(!appDB.auditLog) appDB.auditLog = {};
            if(!appDB.auditLog[appDB.currentCompanyId]) appDB.auditLog[appDB.currentCompanyId] = [];
            appDB.auditLog[appDB.currentCompanyId].push({
                ts: new Date().toISOString(),
                user: getCurrentUserLabel(),
                entity, action, entityLabel,
                before: before !== undefined ? before : null,
                after: after !== undefined ? after : null
            });
        }

        function showToast(msg) {
            const toast = document.getElementById('toast-msg');
            if(!toast) return;
            toast.innerText = msg;
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 3500);
        }

        function showLoginError(msg) {
            const errEl = document.getElementById('login-error');
            if(!errEl) return;
            errEl.innerHTML = msg;
            errEl.style.display = 'block';

            const box = document.querySelector('#login-overlay .login-box');
            if(box) {
                box.classList.remove('shake');
                void box.offsetWidth;
                box.classList.add('shake');
            }
        }

        // --- TRANSIÇÃO LOGIN → LOADING → APP (mínimo garantido, sem "flash") ---
        let loadingShownAt = 0;
        const MIN_LOADING_MS = 700;

        function markLoadingShown() {
            const loadingOverlay = document.getElementById('loading-overlay');
            loadingOverlay.style.display = 'flex';
            loadingOverlay.classList.add('overlay-fade-in');
            setTimeout(() => loadingOverlay.classList.remove('overlay-fade-in'), 600);
            loadingShownAt = Date.now();
        }

        function hideLoadingOverlay(callback) {
            const elapsed = Date.now() - loadingShownAt;
            const wait = Math.max(0, MIN_LOADING_MS - elapsed);
            setTimeout(() => {
                const loadingOverlay = document.getElementById('loading-overlay');
                loadingOverlay.classList.add('overlay-fade-out');
                setTimeout(() => {
                    loadingOverlay.style.display = 'none';
                    loadingOverlay.classList.remove('overlay-fade-out');
                    if(callback) callback();
                }, 600);
            }, wait);
        }

        const CHECK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

        function fadeLoginToLoading(onLoadingShown) {
            setTimeout(() => {
                const loginOverlay = document.getElementById('login-overlay');
                loginOverlay.classList.add('overlay-fade-out');
                setTimeout(() => {
                    loginOverlay.style.display = 'none';
                    loginOverlay.classList.remove('overlay-fade-out');
                    markLoadingShown();
                    if(onLoadingShown) onLoadingShown();
                }, 500);
            }, 1400);
        }

        window.onload = function() {
            try {
                document.getElementById('login-overlay').style.display = 'none';
                markLoadingShown();
                getAuthApp().auth().onAuthStateChanged((user) => {
                    if(appEntered) return;
                    if(user) {
                        appEntered = true;
                        const savedRole = localStorage.getItem('luppus_auth_role') || 'empresa';
                        isClientMode = (savedRole === 'cliente');
                        userRole = savedRole;
                        applyClientModeUI();
                        initFirebase(PROD_FIREBASE_CONFIG, AUTH_APP_NAME);
                        fetchMarketIndices();
                    } else {
                        hideLoadingOverlay(() => { showLoginScreen(); });
                    }
                });
            } catch(e) {
                showLoginScreen();
            }
            fetchExchangeRates();
        };

        function fetchExchangeRates() {
            const pairs = [
                { key: 'USDBRL', valueId: 'quote-usd-value', changeId: 'quote-usd-change', symbol: 'US$' },
                { key: 'EURBRL', valueId: 'quote-eur-value', changeId: 'quote-eur-change', symbol: '€' },
                { key: 'GBPBRL', valueId: 'quote-gbp-value', changeId: 'quote-gbp-change', symbol: '£' }
            ];
            fetch('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,GBP-BRL')
                .then(res => res.json())
                .then(data => {
                    pairs.forEach(p => {
                        const info = data[p.key];
                        if(!info) return;
                        const valueEl = document.getElementById(p.valueId);
                        const changeEl = document.getElementById(p.changeId);
                        if(valueEl) valueEl.textContent = `${p.symbol} ${parseFloat(info.bid).toFixed(2).replace('.', ',')}`;
                        if(changeEl) {
                            const pct = parseFloat(info.pctChange);
                            changeEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}%`;
                            changeEl.classList.toggle('positive', pct >= 0);
                            changeEl.classList.toggle('negative', pct < 0);
                        }
                    });
                })
                .catch(() => {});
        }

        // Índices de bolsa: atualizados no máx. 2x/dia (madrugada/fim de tarde), compartilhado
        // entre todos os usuários via Firestore, para não estourar o limite de 25 consultas/dia da Alpha Vantage.
        const ALPHA_VANTAGE_KEY = '7B0BMN54GWJ6WE5R';
        const MARKET_INDICES = [
            { symbol: 'QQQ', label: 'NASDAQ', changeId: 'quote-nasdaq-change' },
            { symbol: 'EWG', label: 'DAX (Frankfurt)', changeId: 'quote-dax-change' },
            { symbol: 'EWU', label: 'FTSE 100', changeId: 'quote-ftse-change' }
        ];

        function getMarketSlotKey() {
            const shifted = new Date(Date.now() - 6 * 60 * 60 * 1000);
            const slot = shifted.getHours() < 12 ? 'AM' : 'PM';
            return `${shifted.getFullYear()}-${shifted.getMonth()}-${shifted.getDate()}-${slot}`;
        }

        function renderMarketIndices(indices) {
            MARKET_INDICES.forEach(m => {
                const pct = indices[m.label];
                const el = document.getElementById(m.changeId);
                if(el && typeof pct === 'number') {
                    el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}%`;
                    el.classList.toggle('positive', pct >= 0);
                    el.classList.toggle('negative', pct < 0);
                }
            });
        }

        function refreshMarketIndices(marketRef, slotKey) {
            Promise.all(MARKET_INDICES.map(m =>
                fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${m.symbol}&apikey=${ALPHA_VANTAGE_KEY}`)
                    .then(res => res.json())
                    .then(data => {
                        const q = data['Global Quote'];
                        if(!q || !q['10. change percent']) return null;
                        return { label: m.label, pct: parseFloat(q['10. change percent']) };
                    })
                    .catch(() => null)
            )).then(results => {
                const indices = {};
                results.forEach(r => { if(r) indices[r.label] = r.pct; });
                if(Object.keys(indices).length > 0) {
                    marketRef.set({ slot: slotKey, indices }).catch(() => {});
                    renderMarketIndices(indices);
                }
            });
        }

        function fetchMarketIndices() {
            const marketRef = getAuthApp().firestore().collection('luppus_system').doc('market_data');
            const slotKey = getMarketSlotKey();
            // onSnapshot (em vez de .get()) porque tolera melhor a conexão ainda "esquentando"
            // logo após o login, evitando o erro transitório "client is offline" de uma leitura única.
            const unsubscribe = marketRef.onSnapshot((doc) => {
                unsubscribe();
                const data = doc.exists ? doc.data() : null;
                if(data && data.slot === slotKey && data.indices) {
                    renderMarketIndices(data.indices);
                } else {
                    if(data && data.indices) renderMarketIndices(data.indices);
                    refreshMarketIndices(marketRef, slotKey);
                }
            }, () => {});
        }

        function showLoginScreen() {
            document.getElementById('login-overlay').style.display = 'flex';
            document.getElementById('loading-overlay').style.display = 'none';
            const entryDateEl = document.getElementById('entry-date');
            if(entryDateEl) entryDateEl.value = getTodayDate();
        }

        // --- LOGIN: ABAS, SENHA, RECUPERAÇÃO E CADASTRO ---
        function switchLoginTab(tab) {
            document.querySelectorAll('.login-tab').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.login-tab-panel').forEach(el => el.classList.remove('active'));
            const tabBtn = document.querySelector(`.login-tab[data-tab="${tab}"]`);
            if(tabBtn) tabBtn.classList.add('active');
            const panel = document.getElementById('login-panel-' + tab);
            if(panel) panel.classList.add('active');
            const errEl = document.getElementById('login-error');
            if(errEl) errEl.style.display = 'none';
        }

        function togglePasswordVisibility(inputId, btnEl) {
            const input = document.getElementById(inputId);
            if(!input) return;
            const willShow = input.type === 'password';
            input.type = willShow ? 'text' : 'password';
            btnEl.setAttribute('aria-label', willShow ? 'ocultar' : 'mostrar');
            btnEl.innerHTML = willShow
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        }

        const ALLOWED_DEV_EMAILS = ['devkaique@luppus.com', 'devalmir@luppus.com'];
        const LOGIN_BTN_IDS = { empresa: 'btn-login-empresa', cliente: 'btn-login-cliente', dev: 'btn-login-dev' };

        function doPasswordLogin(role) {
            const email = document.getElementById(role + '-email-input').value.trim();
            const password = document.getElementById(role + '-password-input').value.trim();
            if(!email || !password) { showLoginError('Preencha e-mail e senha.'); return; }

            if(role === 'dev' && !ALLOWED_DEV_EMAILS.includes(email.toLowerCase())) {
                showLoginError('Este e-mail não tem acesso à área de desenvolvedor.');
                return;
            }

            const btn = document.getElementById(LOGIN_BTN_IDS[role]);
            const originalText = btn ? btn.textContent : '';
            if(btn) btn.disabled = true;

            getAuthApp().auth().signInWithEmailAndPassword(email, password)
                .then(() => {
                    appEntered = true;
                    const clientCheckEl = document.getElementById('client-mode-check');
                    const effectiveRole = (role === 'dev' && clientCheckEl && clientCheckEl.checked) ? 'cliente' : role;
                    isClientMode = (effectiveRole === 'cliente');
                    userRole = effectiveRole;
                    try { localStorage.setItem('luppus_auth_role', effectiveRole); } catch(e) {}
                    if(btn) {
                        btn.classList.add('btn-success');
                        btn.innerHTML = CHECK_SVG;
                    }
                    fadeLoginToLoading(() => {
                        if(btn) {
                            btn.disabled = false;
                            btn.classList.remove('btn-success');
                            btn.textContent = originalText;
                        }
                        applyClientModeUI();
                        setTimeout(() => { initFirebase(PROD_FIREBASE_CONFIG, AUTH_APP_NAME); }, 100);
                        fetchMarketIndices();
                    });
                })
                .catch((error) => {
                    if(btn) btn.disabled = false;
                    showLoginError(translateAuthError(error.code));
                });
        }

        function openForgotPassword() {
            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('forgot-password-overlay').style.display = 'flex';
            resetRecoveryFlow();
        }
        function closeForgotPassword() {
            document.getElementById('forgot-password-overlay').style.display = 'none';
            document.getElementById('login-overlay').style.display = 'flex';
            resetRecoveryFlow();
        }
        function resetRecoveryFlow() {
            document.getElementById('recovery-contact-input').value = '';
        }
        function sendRecoveryCode() {
            const contact = document.getElementById('recovery-contact-input').value.trim();
            if(!contact) { showToast('Preencha o campo de e-mail.'); return; }

            const btn = document.getElementById('recovery-submit-btn');
            if(btn) btn.disabled = true;

            getAuthApp().auth().sendPasswordResetEmail(contact)
                .then(() => {
                    showToast('Enviamos um link de redefinição de senha para o seu e-mail.');
                    closeForgotPassword();
                })
                .catch((error) => {
                    showToast(translateAuthError(error.code));
                })
                .finally(() => { if(btn) btn.disabled = false; });
        }

        (function setupCnpjAutocomplete() {
            const input = document.getElementById('signup-company-input');
            if(!input) return;
            input.addEventListener('input', () => {
                const digits = input.value.replace(/\D/g, '');
                if(digits.length !== 14) return;
                fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`)
                    .then(res => { if(!res.ok) throw new Error('not found'); return res.json(); })
                    .then(data => {
                        const name = data.razao_social || data.nome_fantasia;
                        if(name) input.value = name;
                    })
                    .catch(() => {});
            });
        })();

        function openSignup() {
            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('signup-overlay').style.display = 'flex';
        }
        function closeSignup() {
            document.getElementById('signup-overlay').style.display = 'none';
            document.getElementById('login-overlay').style.display = 'flex';
        }
        function doSignup() {
            const name = document.getElementById('signup-name-input').value.trim();
            const company = document.getElementById('signup-company-input').value.trim();
            const email = document.getElementById('signup-email-input').value.trim();
            const password = document.getElementById('signup-password-input').value.trim();
            const passwordConfirm = document.getElementById('signup-password-confirm-input').value.trim();

            if(!name || !company || !email || !password) { showToast('Preencha todos os campos.'); return; }
            if(password !== passwordConfirm) { showToast('As senhas não coincidem.'); return; }
            if(password.length < 6) { showToast('A senha precisa ter pelo menos 6 caracteres.'); return; }

            const btn = document.getElementById('signup-submit-btn');
            if(btn) btn.disabled = true;

            getAuthApp().auth().createUserWithEmailAndPassword(email, password)
                .then((cred) => cred.user.updateProfile({ displayName: name }))
                .then(() => {
                    appEntered = true;
                    try { localStorage.setItem('luppus_auth_role', 'empresa'); } catch(e) {}
                    isClientMode = false;
                    userRole = 'empresa';
                    document.getElementById('signup-overlay').style.display = 'none';
                    showToast('Conta criada com sucesso!');
                    markLoadingShown();
                    applyClientModeUI();
                    initFirebase(PROD_FIREBASE_CONFIG, AUTH_APP_NAME);
                    fetchMarketIndices();
                })
                .catch((error) => {
                    if(btn) btn.disabled = false;
                    showToast(translateAuthError(error.code));
                });
        }

        function startDemo() {
            appEntered = true;
            const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
            const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
            const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };

            appDB = {
                companies: [{ id: "demo", name: "LUPPUS Demo", info: "Ambiente de demonstração" }],
                currentCompanyId: "demo",
                transactions: { demo: (() => {
                    const demoReceipt = { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", name: "comprovante.txt" };
                    return [
                        { date: daysAgo(1), desc: "Pagamento Consultoria - Cliente Vetta", type: "in", amount: 18500, category: "Consultoria", receipt: demoReceipt },
                        { date: daysAgo(2), desc: "Infraestrutura Cloud (AWS)", type: "out", amount: 2340.50, category: "Infraestrutura", receipt: demoReceipt },
                        { date: daysAgo(4), desc: "Folha de Pagamento", type: "out", amount: 45200, category: "Folha de Pagamento", receipt: demoReceipt },
                        { date: daysAgo(6), desc: "Receita Recorrente SaaS", type: "in", amount: 9800, category: "Vendas", receipt: demoReceipt },
                        { date: daysAgo(9), desc: "Consultoria Jurídica", type: "out", amount: 3100, category: "Consultoria", receipt: demoReceipt },
                        { date: daysAgo(12), desc: "Novo Contrato - Cliente Aurora", type: "in", amount: 27400, category: "Vendas", receipt: demoReceipt },
                        { date: daysAgo(15), desc: "Licenças de Software", type: "out", amount: 1890, category: "Infraestrutura", receipt: demoReceipt },
                        { date: daysAgo(20), desc: "Consultoria Estratégica", type: "in", amount: 15600, category: "Consultoria", receipt: demoReceipt },
                        { date: daysAgo(1), desc: "Reembolso Viagem - Aguardando Nota Fiscal", type: "out", amount: 1250, category: "Outro", receipt: null }
                    ];
                })() },
                spreadsheets: { demo: [
                    { id: "sheet-demo-1", name: "Controle de Fornecedores", data: [
                        ['Fornecedor', 'Contato', 'Categoria', 'Aprovado?'],
                        ['Cloud Provider AWS', 'contas@aws.com', 'Infraestrutura', 'Sim'],
                        ['Escritório Jurídico Lima', 'contato@limaadv.com', 'Jurídico', 'Sim'],
                        ['Consultoria Estratégica X', 'contato@consultx.com', 'Consultoria', 'Não']
                    ] },
                    { id: "sheet-demo-2", name: "Estoque", data: [
                        ['Item', 'Quantidade', 'Estoque Mínimo', 'Status'],
                        ['Notebooks', '12', '5', 'OK'],
                        ['Licenças SaaS', '30', '10', 'OK'],
                        ['Cadeiras', '3', '5', 'Repor']
                    ] }
                ] },
                spreadsheetActiveId: { demo: "sheet-demo-1" },
                vault: { demo: [
                    { name: "Contrato Social", category: "Contrato", date: daysAgo(30), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "contrato-social.txt" } },
                    { name: "Certidão Negativa de Débitos", category: "Certidão", date: daysAgo(60), expiry: daysAgo(5), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "certidao-negativa.txt" } },
                    { name: "Nota Fiscal - Consultoria", category: "Nota Fiscal", date: daysAgo(10), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "nota-fiscal.txt" } },
                    { name: "Certidão FGTS", category: "Certidão", date: daysAgo(45), expiry: daysFromNow(12), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "certidao-fgts.txt" } },
                    { name: "Comprovante de Endereço", category: "Comprovante", date: daysAgo(90), expiry: daysFromNow(200), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "comprovante-endereco.txt" } }
                ] }
            };
            isClientMode = false;
            userRole = 'empresa';
            applyClientModeUI();

            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('loading-overlay').style.display = 'none';
            const demoBanner = document.getElementById('demo-banner');
            if(demoBanner) demoBanner.style.display = 'block';

            const entryDateEl = document.getElementById('entry-date');
            if(entryDateEl) entryDateEl.value = getTodayDate();

            renderCompanyDropdown();
            renderCategoryUI();
            applySmartSearch();
            renderVault();
        }

        function startDemoWithAnimation() {
            const cta = document.querySelector('#login-overlay .demo-cta');
            let iconEl, textEl, originalIconHTML, originalTextHTML;
            if(cta) {
                iconEl = cta.querySelector('.demo-cta-icon');
                textEl = cta.querySelector('.demo-cta-text');
                originalIconHTML = iconEl.innerHTML;
                originalTextHTML = textEl.innerHTML;
                cta.disabled = true;
                cta.classList.add('demo-cta-success');
                iconEl.innerHTML = CHECK_SVG;
                textEl.innerHTML = '<strong>acesso confirmado</strong><span>carregando dados de exemplo...</span>';
            }

            fadeLoginToLoading(() => {
                if(cta) {
                    cta.disabled = false;
                    cta.classList.remove('demo-cta-success');
                    iconEl.innerHTML = originalIconHTML;
                    textEl.innerHTML = originalTextHTML;
                }
                hideLoadingOverlay(() => { startDemo(); startTour(); });
            });
        }

        // --- TOUR GUIADO (tutorial interativo da demonstração) ---
        const TOUR_STEPS = [
            { view: 'painel', selector: '.sidebar', title: 'Bem-vindo ao LUPPUS', text: 'Esse é o menu principal — daqui você navega entre painel, lançamentos, auditoria, planilhas, cofre digital e mais.' },
            { view: 'painel', selector: '#view-painel .kpi-grid', title: 'Visão geral em números', text: 'Receita, custos, resultado líquido e a projeção de saldo para os próximos 30 dias, sempre atualizados.' },
            { view: 'painel', selector: '#painel-alerts-grid', title: 'Avisos automáticos', text: 'O sistema avisa sozinho quando há lançamentos pendentes ou documentos vencendo em breve.' },
            { view: 'painel', selector: '#quotes-panel-card', title: 'Cotações ao vivo', text: 'Câmbio em tempo real e índices de bolsa, direto no painel.' },
            { view: 'lancamentos', selector: '#entry-submit-btn', title: 'Lance receitas e custos', text: 'Preencha os dados e anexe um comprovante — sem comprovante, o lançamento fica "pendente" até você regularizar.' },
            { view: 'relatorios', selector: '#view-relatorios .smart-search-box', title: 'Busca inteligente', text: 'Digite em português o que procura, como "custos com infraestrutura", ou use os filtros rápidos ao lado.' },
            { view: 'planilhas', selector: '#templates-panel-card', title: 'Planilhas com modelos prontos', text: 'Controle de estoque, cronogramas, contratos e mais — aplique um modelo pronto com um clique.' },
            { view: 'cofre', selector: '#view-cofre .dashboard-lower-grid', title: 'Cofre digital', text: 'Guarde contratos e certidões com data de validade — o sistema avisa antes de vencer.' },
            { view: 'config', selector: '.config-tabs', title: 'Configurações por perfil', text: 'Cada tipo de acesso (cliente, empresa ou dev) vê só as abas que fazem sentido para ele.' },
            { view: 'suporte', selector: '.faq-tabs', title: 'Dúvidas? Estamos aqui', text: 'FAQ organizado por área, e um chat ao vivo para falar com a gente na hora.' }
        ];
        let tourStepIndex = 0;
        let tourRenderGen = 0;

        function startTour() {
            tourStepIndex = 0;
            document.getElementById('tour-overlay').style.display = 'block';
            renderTourStep();
        }

        function renderTourStep() {
            const myGen = ++tourRenderGen;
            const step = TOUR_STEPS[tourStepIndex];
            switchView(step.view);
            // No celular a barra lateral fica escondida por padrão — abre ela pra esse passo específico
            // poder ser destacado, já que switchView() a fecha de novo automaticamente.
            if(step.selector === '.sidebar') {
                const navToggle = document.getElementById('nav-toggle');
                if(navToggle) navToggle.checked = true;
            }
            setTimeout(() => {
                if(myGen !== tourRenderGen) return;
                const target = document.querySelector(step.selector);
                if(!target) { nextTourStep(); return; }
                target.scrollIntoView({ block: 'center' });
                setTimeout(() => {
                    if(myGen !== tourRenderGen) return;
                    const rect = target.getBoundingClientRect();
                    positionTourMasks(rect);
                    document.getElementById('tour-step-counter').textContent = (tourStepIndex + 1) + ' / ' + TOUR_STEPS.length;
                    document.getElementById('tour-title').textContent = step.title;
                    document.getElementById('tour-text').textContent = step.text;
                    document.getElementById('tour-prev-btn').style.visibility = tourStepIndex === 0 ? 'hidden' : 'visible';
                    document.getElementById('tour-next-btn').textContent = tourStepIndex === TOUR_STEPS.length - 1 ? 'concluir' : 'próximo';
                    positionTourCard(rect);
                }, 80);
            }, 80);
        }

        function positionTourMasks(rect) {
            const pad = 8;
            const top = Math.max(0, rect.top - pad);
            const left = Math.max(0, rect.left - pad);
            const right = Math.min(window.innerWidth, rect.right + pad);
            const bottom = Math.min(window.innerHeight, rect.bottom + pad);

            document.getElementById('tour-mask-top').style.cssText = `top:0; left:0; width:100%; height:${top}px;`;
            document.getElementById('tour-mask-bottom').style.cssText = `top:${bottom}px; left:0; width:100%; height:${Math.max(0, window.innerHeight - bottom)}px;`;
            document.getElementById('tour-mask-left').style.cssText = `top:${top}px; left:0; width:${left}px; height:${bottom - top}px;`;
            document.getElementById('tour-mask-right').style.cssText = `top:${top}px; left:${right}px; width:${Math.max(0, window.innerWidth - right)}px; height:${bottom - top}px;`;
            document.getElementById('tour-highlight-box').style.cssText = `top:${top}px; left:${left}px; width:${right - left}px; height:${bottom - top}px;`;
        }

        function positionTourCard(rect) {
            const card = document.getElementById('tour-card');
            card.style.top = '-9999px';
            card.style.left = '-9999px';
            card.style.visibility = 'hidden';
            requestAnimationFrame(() => {
                const cardRect = card.getBoundingClientRect();
                const margin = 20;
                let top, left;

                if(rect.bottom + margin + cardRect.height <= window.innerHeight - 10) {
                    top = rect.bottom + margin; left = rect.left;
                } else if(rect.top - margin - cardRect.height >= 10) {
                    top = rect.top - margin - cardRect.height; left = rect.left;
                } else if(rect.right + margin + cardRect.width <= window.innerWidth - 10) {
                    top = rect.top; left = rect.right + margin;
                } else if(rect.left - margin - cardRect.width >= 10) {
                    top = rect.top; left = rect.left - margin - cardRect.width;
                } else {
                    top = window.innerHeight - cardRect.height - margin; left = window.innerWidth - cardRect.width - margin;
                }

                left = Math.max(10, Math.min(left, window.innerWidth - cardRect.width - 10));
                top = Math.max(10, Math.min(top, window.innerHeight - cardRect.height - 10));
                card.style.top = top + 'px';
                card.style.left = left + 'px';
                card.style.visibility = 'visible';
            });
        }

        function nextTourStep() {
            if(tourStepIndex >= TOUR_STEPS.length - 1) { endTour(); return; }
            tourStepIndex++;
            renderTourStep();
        }
        function prevTourStep() {
            if(tourStepIndex === 0) return;
            tourStepIndex--;
            renderTourStep();
        }
        function skipTour() { endTour(); }
        function endTour() {
            document.getElementById('tour-overlay').style.display = 'none';
        }

        function doLogout() {
            try {
                localStorage.removeItem('luppus_node_keys');
                localStorage.removeItem('luppus_client_mode');
                localStorage.removeItem('luppus_auth_role');
            } catch(e) {}
            const authApp = firebase.apps.find(a => a.name === AUTH_APP_NAME);
            if(authApp) {
                authApp.auth().signOut().finally(() => window.location.reload());
            } else {
                window.location.reload();
            }
        }
        
        function applyClientModeUI() {
            document.body.classList.toggle('client-mode', isClientMode);
            applyConfigTabVisibility();
        }

        function applyConfigTabVisibility() {
            const empresaTabBtn = document.querySelector('.config-tab[data-tab="empresa"]');
            const devTabBtn = document.querySelector('.config-tab[data-tab="dev"]');
            if(empresaTabBtn) empresaTabBtn.style.display = (userRole === 'cliente') ? 'none' : '';
            if(devTabBtn) devTabBtn.style.display = (userRole === 'dev') ? '' : 'none';

            const activeTab = document.querySelector('.config-tab.active');
            const activeTabName = activeTab ? activeTab.getAttribute('data-tab') : 'cliente';
            const allowed = userRole === 'dev' || (userRole === 'empresa' && activeTabName !== 'dev') || (userRole === 'cliente' && activeTabName === 'cliente');
            if(!allowed) switchConfigTab('cliente');
        }

        function initFirebase(config, appName) {
            try {
                let app;
                if(appName) {
                    app = firebase.apps.find(a => a.name === appName) || firebase.initializeApp(config, appName);
                } else {
                    if (!firebase.apps.length) firebase.initializeApp(config);
                    app = firebase.app();
                }
                cloudDB = app.firestore();

                // Cada conta autenticada tem seu próprio documento (isolado por UID) — evita
                // que empresas/clientes diferentes leiam ou sobrescrevam os dados uns dos outros.
                const currentUser = app.auth ? app.auth().currentUser : null;
                currentDocId = currentUser ? currentUser.uid : 'node_state';

                const docRef = cloudDB.collection("luppus_system").doc(currentDocId);
                attachFirestoreListener(docRef, 0);
            } catch(e) {
                showLoginError("Erro na Conexão:<br>" + e.message);
                doLogoutFallback();
            }
        }

        // Erros de rede/serviço passageiros (ex: instabilidade momentânea) não significam bloqueio
        // de permissão de verdade — vale tentar de novo antes de mostrar um erro pro usuário.
        const FIRESTORE_TRANSIENT_CODES = ['unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'resource-exhausted', 'unknown', 'internal'];
        const FIRESTORE_MAX_RETRIES = 3;

        function attachFirestoreListener(docRef, attempt) {
            docRef.onSnapshot((doc) => {
                hideLoadingOverlay(() => {
                    const entryDateEl = document.getElementById('entry-date');
                    if(entryDateEl) entryDateEl.value = getTodayDate();

                    if (doc.exists) {
                        appDB = unpackSpreadsheets(doc.data());
                        if(!appDB.currentCompanyId || !appDB.companies.find(c => c.id === appDB.currentCompanyId)) {
                            appDB.currentCompanyId = appDB.companies[0].id;
                        }
                        if(!appDB.spreadsheets) appDB.spreadsheets = {};
                        if(!appDB.vault) appDB.vault = {};

                        renderCompanyDropdown();
                        renderCategoryUI();
                        applySmartSearch();
                        renderVault();
                        if(!isClientMode && document.getElementById('view-planilhas').classList.contains('active')) initSpreadsheet();
                    } else {
                        saveToCloud();
                        renderCompanyDropdown();
                        renderCategoryUI();
                        applySmartSearch();
                    }
                });
            }, (error) => {
                if(FIRESTORE_TRANSIENT_CODES.includes(error.code) && attempt < FIRESTORE_MAX_RETRIES) {
                    setTimeout(() => attachFirestoreListener(docRef, attempt + 1), 1500 * (attempt + 1));
                    return;
                }
                if(error.code === 'permission-denied' || error.code === 'unauthenticated') {
                    showLoginError("Acesso Negado.<br>Verifique as Regras de Segurança no Firebase.");
                } else {
                    showLoginError("Problema de conexão com o servidor.<br>Verifique sua internet e tente novamente.");
                }
                doLogoutFallback();
            });
        }

        function doLogoutFallback() {
            document.getElementById('loading-overlay').style.display = 'none';
            document.getElementById('login-overlay').style.display = 'flex';
            try { localStorage.removeItem('luppus_node_keys'); localStorage.removeItem('luppus_client_mode'); localStorage.removeItem('luppus_auth_role'); } catch(e) {}
            const authApp = firebase.apps.find(a => a.name === AUTH_APP_NAME);
            if(authApp) authApp.auth().signOut();
        }

        // Evita perder um salvamento em andamento se a página for fechada/recarregada
        // antes do navegador confirmar o envio pro servidor.
        let pendingSaves = 0;
        window.addEventListener('beforeunload', (e) => {
            if(pendingSaves > 0) { e.preventDefault(); e.returnValue = ''; }
        });

        // Fecha o modal aberto no topo com a tecla Esc (login/loading não entram — não são dispensáveis).
        window.addEventListener('keydown', (e) => {
            if(e.key !== 'Escape') return;
            const isOpen = (id) => { const el = document.getElementById(id); return el && el.style.display !== 'none' && el.style.display !== ''; };
            if(isOpen('vault-preview-overlay')) closeVaultPreview();
            else if(isOpen('wipe-overlay')) closeWipeModal();
            else if(isOpen('new-company-overlay')) closeNewCompanyModal();
            else if(isOpen('signup-overlay')) closeSignup();
            else if(isOpen('forgot-password-overlay')) closeForgotPassword();
        });

        // O Firestore não aceita listas dentro de listas — e é assim que a planilha guarda
        // os dados (lista de linhas, cada linha uma lista de células). Por isso, ao salvar,
        // cada planilha vira um texto (JSON) só nesse momento; ao carregar, volta ao normal.
        function packSpreadsheetsForSave(db) {
            const clone = JSON.parse(JSON.stringify(db));
            if(clone.spreadsheets) {
                Object.keys(clone.spreadsheets).forEach(companyId => {
                    (clone.spreadsheets[companyId] || []).forEach(sheet => {
                        if(Array.isArray(sheet.data)) sheet.data = JSON.stringify(sheet.data);
                    });
                });
            }
            return clone;
        }

        function unpackSpreadsheets(db) {
            if(db.spreadsheets) {
                Object.keys(db.spreadsheets).forEach(companyId => {
                    (db.spreadsheets[companyId] || []).forEach(sheet => {
                        if(typeof sheet.data === 'string') {
                            try { sheet.data = JSON.parse(sheet.data); } catch(e) { sheet.data = []; }
                        }
                    });
                });
            }
            return db;
        }

        function saveToCloud() {
            if(!cloudDB) return;
            pendingSaves++;
            const payload = packSpreadsheetsForSave(appDB);
            cloudDB.collection("luppus_system").doc(currentDocId).set(payload)
                .catch(err => { if(!isClientMode) showToast("Erro de Sincronização."); })
                .finally(() => { pendingSaves--; });
        }

        function renderCompanyDropdown() {
            const select = document.getElementById('global-company-select');
            if(!select) return;
            select.innerHTML = '';
            let currentName = "EMPRESA";
            appDB.companies.forEach(company => {
                const opt = document.createElement('option');
                opt.value = company.id;
                opt.innerText = company.name;
                if (company.id === appDB.currentCompanyId) {
                    opt.selected = true;
                    currentName = company.name;
                }
                select.appendChild(opt);
            });
            
            if(isClientMode) {
                document.getElementById('client-company-label').innerText = currentName.toUpperCase();
                document.getElementById('client-company-label').style.display = 'block';
            }
        }

        function switchCompany(companyId) {
            appDB.currentCompanyId = companyId;
            saveToCloud();
            renderCompanyDropdown();
            renderCategoryUI();
            applySmartSearch();
            renderVault();
            pendingOFX = [];
            if(document.getElementById('view-planilhas').classList.contains('active')) initSpreadsheet();
            if(document.getElementById('view-projecao').classList.contains('active')) updateForecasting();
        }

        function openNewCompanyModal() { document.getElementById('new-company-overlay').style.display = 'flex'; }
        function closeNewCompanyModal() { document.getElementById('new-company-overlay').style.display = 'none'; }
        function saveNewCompany() {
            const name = document.getElementById('new-company-name').value.trim();
            const info = document.getElementById('new-company-info').value.trim();
            if (!name) return;
            const newId = "comp_" + Date.now();
            appDB.companies.push({ id: newId, name: name, info: info });
            appDB.transactions[newId] = []; appDB.spreadsheets[newId] = []; appDB.vault[newId] = [];
            closeNewCompanyModal();
            switchCompany(newId); 
        }

        // --- VIEWS ---
        function switchView(viewId) {
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            const activeMenu = document.getElementById('menu-' + viewId);
            if(activeMenu) activeMenu.classList.add('active');

            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
            const activeView = document.getElementById('view-' + viewId);
            if(activeView) activeView.classList.add('active');

            const titles = { 'painel': 'visão geral', 'lancamentos': 'lançamentos', 'relatorios': 'auditoria', 'projecao':'forecasting (previsão)', 'planilhas': 'workspaces (planilhas)', 'bi': 'data studio (dados)', 'cofre': 'cofre corporativo', 'config': 'configurações', 'suporte': 'suporte' };
            document.getElementById('current-view-title').innerText = titles[viewId] || 'painel';

            if(viewId === 'planilhas') initSpreadsheet();
            if(viewId === 'projecao') updateForecasting();
            if(viewId === 'config') loadConfigSettingsUI();
            if(viewId === 'suporte') { injectFaqFeedbackButtons(); updateSupportStatus(); renderSupportTicketHistory(); }

            const navToggle = document.getElementById('nav-toggle');
            if(navToggle) navToggle.checked = false;
        }

        function switchFaqTab(tab) {
            document.querySelectorAll('.faq-tab').forEach(el => el.classList.remove('active'));
            const activeTab = document.querySelector('.faq-tab[data-tab="' + tab + '"]');
            if(activeTab) activeTab.classList.add('active');

            document.querySelectorAll('.faq-tab-panel').forEach(el => el.classList.remove('active'));
            const activePanel = document.getElementById('faq-tab-' + tab);
            if(activePanel) activePanel.classList.add('active');
            filterFaqItems();
        }

        function filterFaqItems() {
            const searchEl = document.getElementById('faq-search');
            const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
            const activePanel = document.querySelector('.faq-tab-panel.active');
            if(!activePanel) return;
            let matchCount = 0;
            activePanel.querySelectorAll('.faq-item').forEach(item => {
                const matches = !query || item.textContent.toLowerCase().includes(query);
                item.style.display = matches ? '' : 'none';
                if(matches) matchCount++;
            });
            let emptyNote = activePanel.querySelector('.faq-empty-note');
            if(matchCount === 0 && query) {
                if(!emptyNote) {
                    emptyNote = document.createElement('p');
                    emptyNote.className = 'empty-state faq-empty-note';
                    emptyNote.textContent = 'Nada encontrado nesta área para essa busca — tente outra aba ou fale com a gente ao final da página.';
                    activePanel.querySelector('.faq-list').appendChild(emptyNote);
                }
            } else if(emptyNote) {
                emptyNote.remove();
            }
        }

        function faqItemKey(item) {
            const summary = item.querySelector('summary');
            return summary ? summary.textContent.trim() : '';
        }

        function injectFaqFeedbackButtons() {
            document.querySelectorAll('.faq-item').forEach(item => {
                if(item.querySelector('.faq-feedback-row')) return;
                const key = faqItemKey(item);
                if(!key) return;
                const row = document.createElement('div');
                row.className = 'faq-feedback-row';
                row.style.cssText = 'margin-top:10px; display:flex; align-items:center; gap:10px; font-size:11px; color:var(--text-muted);';
                row.innerHTML = `<span>Isso ajudou?</span>
                    <button type="button" class="outline-btn" style="padding:3px 10px; font-size:10px;" onclick="rateFaqItem(this, true)">sim</button>
                    <button type="button" class="outline-btn" style="padding:3px 10px; font-size:10px;" onclick="rateFaqItem(this, false)">não</button>
                    <span class="faq-feedback-thanks" style="display:none;">valeu pelo retorno!</span>`;
                row.dataset.faqKey = key;
                item.appendChild(row);
            });
        }

        function rateFaqItem(btn, helpful) {
            const row = btn.closest('.faq-feedback-row');
            const key = row.dataset.faqKey;
            if(!appDB.faqFeedback) appDB.faqFeedback = {};
            if(!appDB.faqFeedback[key]) appDB.faqFeedback[key] = { yes: 0, no: 0 };
            appDB.faqFeedback[key][helpful ? 'yes' : 'no']++;
            saveToCloud();
            row.querySelectorAll('button').forEach(b => b.disabled = true);
            row.querySelector('.faq-feedback-thanks').style.display = 'inline';
        }

        const MAILER_URL = 'https://luppus-mailer.luppus.workers.dev';
        const MAILER_APP_SECRET = 'ef98de4a84dd53f625dcef630ad9553f1e2bfa420335ffeb';

        function sendTestReport() {
            const emailInput = document.getElementById('contact-email-input');
            const to = emailInput ? emailInput.value.trim() : '';
            if(!to) { showToast('Preencha o e-mail de contato na aba Cliente antes de testar.'); return; }

            const company = appDB.companies.find(c => c.id === appDB.currentCompanyId);
            const receita = document.getElementById('total-in') ? document.getElementById('total-in').textContent : 'R$ 0,00';
            const custos = document.getElementById('total-out') ? document.getElementById('total-out').textContent : 'R$ 0,00';
            const resultado = document.getElementById('net-cash') ? document.getElementById('net-cash').textContent : 'R$ 0,00';

            showToast('Enviando relatório de teste...');
            fetch(MAILER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-App-Secret': MAILER_APP_SECRET },
                body: JSON.stringify({
                    to,
                    type: 'weekly_report',
                    companyName: company ? company.name : '',
                    data: { receita, custos, resultado }
                })
            })
            .then(res => res.json().then(data => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
                if(ok) {
                    showToast('Relatório de teste enviado! Verifique a caixa de entrada.');
                } else {
                    showToast('Falha ao enviar: ' + (data.message || data.error || 'erro desconhecido'));
                }
            })
            .catch(() => showToast('Falha de conexão ao enviar o relatório.'));
        }

        function openSupportChat() {
            if(typeof Tawk_API !== 'undefined' && Tawk_API.maximize) {
                Tawk_API.maximize();
            } else {
                showToast('Chat carregando... tente novamente em instantes.');
            }
        }

        function updateSupportStatus() {
            const chip = document.getElementById('support-status-chip');
            const note = document.getElementById('support-status-note');
            if(!chip) return;
            if(cloudDB) {
                chip.textContent = '● operacional';
                chip.className = 'chip chip-success';
                if(note) note.textContent = 'Conectado normalmente. Se algo parecer travado mesmo assim, tente recarregar a página antes de reportar.';
            } else {
                chip.textContent = '● modo demonstração';
                chip.className = 'chip';
                if(note) note.textContent = 'Você está no modo de demonstração — sem conexão real com o banco de dados. Isso é esperado, não é uma falha.';
            }
        }

        function submitSupportTicket() {
            const severity = document.getElementById('ticket-severity').value;
            const view = document.getElementById('ticket-view').value;
            const desc = document.getElementById('ticket-desc').value.trim();
            if(!desc) { showToast('Descreva o que aconteceu antes de enviar.'); return; }

            if(!appDB.supportTickets) appDB.supportTickets = {};
            if(!appDB.supportTickets[appDB.currentCompanyId]) appDB.supportTickets[appDB.currentCompanyId] = [];
            appDB.supportTickets[appDB.currentCompanyId].push({
                ts: new Date().toISOString(), user: getCurrentUserLabel(), severity, view, desc, status: 'aberto'
            });
            saveToCloud();
            document.getElementById('ticket-desc').value = '';
            renderSupportTicketHistory();
            showToast('Relato enviado. Obrigado — vamos olhar assim que possível.');
        }

        function renderSupportTicketHistory() {
            const container = document.getElementById('support-ticket-history');
            if(!container) return;
            const tickets = (appDB.supportTickets && appDB.supportTickets[appDB.currentCompanyId]) || [];
            if(tickets.length === 0) { container.innerHTML = ''; return; }
            const severityColor = { alta: 'var(--danger)', media: 'var(--gold)', baixa: 'var(--text-muted)' };
            const rows = tickets.slice().reverse().slice(0, 10).map(t => {
                const when = new Date(t.ts);
                const whenLabel = isNaN(when.getTime()) ? t.ts : when.toLocaleString('pt-BR');
                return `<div class="aging-row"><span><span class="chip" style="color:${severityColor[t.severity] || 'var(--text-muted)'};">${escapeHtml(t.severity)}</span> ${escapeHtml(t.view)}: ${escapeHtml(t.desc.substring(0, 60))}${t.desc.length > 60 ? '…' : ''}</span><span style="color:var(--text-muted); font-size:10px;">${whenLabel}</span></div>`;
            }).join('');
            container.innerHTML = `<h3 class="subsection-title" style="margin-top:0;">seus relatos recentes</h3>` + rows;
        }

        function switchConfigTab(tab) {
            document.querySelectorAll('.config-tab').forEach(el => el.classList.remove('active'));
            const activeTab = document.querySelector('.config-tab[data-tab="' + tab + '"]');
            if(activeTab) activeTab.classList.add('active');

            document.querySelectorAll('.config-tab-panel').forEach(el => el.classList.remove('active'));
            const activePanel = document.getElementById('config-tab-' + tab);
            if(activePanel) activePanel.classList.add('active');
        }

        let notifiedRiskCriticalFor = null;
        let notifiedBelowThresholdFor = null;
        function checkForecastNotifications(isCritical, projectedEnd) {
            const prefs = (appDB.notificationPrefs && appDB.notificationPrefs[appDB.currentCompanyId]) || {};
            const key = appDB.currentCompanyId;

            if(prefs.riskCritical && isCritical && notifiedRiskCriticalFor !== key) {
                showToast('⚠ risco de caixa crítico: a projeção indica saldo negativo no horizonte atual.');
                notifiedRiskCriticalFor = key;
            } else if(!isCritical) {
                notifiedRiskCriticalFor = null;
            }

            const thresholdVal = parseFloat(prefs.balanceThreshold);
            if(prefs.balanceThreshold && !isNaN(thresholdVal)) {
                if(projectedEnd < thresholdVal && notifiedBelowThresholdFor !== key) {
                    showToast(`⚠ saldo projetado (R$ ${projectedEnd.toLocaleString('pt-BR', {minimumFractionDigits: 2})}) abaixo do limite definido (R$ ${thresholdVal.toLocaleString('pt-BR', {minimumFractionDigits: 2})}).`);
                    notifiedBelowThresholdFor = key;
                } else if(projectedEnd >= thresholdVal) {
                    notifiedBelowThresholdFor = null;
                }
            }
        }

        function loadConfigSettingsUI() {
            const prefs = (appDB.notificationPrefs && appDB.notificationPrefs[appDB.currentCompanyId]) || {};
            const riskEl = document.getElementById('notify-risk-critical');
            const balEl = document.getElementById('notify-balance-threshold');
            const highValEl = document.getElementById('notify-high-value-entry');
            if(riskEl) riskEl.checked = !!prefs.riskCritical;
            if(balEl) balEl.value = prefs.balanceThreshold || '';
            if(highValEl) highValEl.checked = !!prefs.highValueEntry;

            const thresholdEl = document.getElementById('approval-threshold-input');
            if(thresholdEl) thresholdEl.value = (appDB.approvalThreshold && appDB.approvalThreshold[appDB.currentCompanyId]) || '';

            renderAccessReviewNote();
            renderSettingsAuditLog();
        }

        function saveNotificationPrefs() {
            if(!appDB.notificationPrefs) appDB.notificationPrefs = {};
            appDB.notificationPrefs[appDB.currentCompanyId] = {
                riskCritical: document.getElementById('notify-risk-critical').checked,
                balanceThreshold: document.getElementById('notify-balance-threshold').value,
                highValueEntry: document.getElementById('notify-high-value-entry').checked
            };
            saveToCloud();
            showToast('Preferências de notificação salvas.');
        }

        function saveApprovalThreshold() {
            if(!appDB.approvalThreshold) appDB.approvalThreshold = {};
            const val = document.getElementById('approval-threshold-input').value;
            appDB.approvalThreshold[appDB.currentCompanyId] = val;
            saveToCloud();
            showToast('Limite de aprovação salvo.');
        }

        function renderAccessReviewNote() {
            const el = document.getElementById('access-review-note');
            if(!el) return;
            if(!appDB.lastAccessReview) appDB.lastAccessReview = {};
            const lastReview = appDB.lastAccessReview[appDB.currentCompanyId];
            const lastDate = parseBRDate(lastReview);
            if(!lastDate) { el.innerHTML = `<span style="color: var(--gold);">Ainda não há registro de revisão de acesso.</span> Boas práticas de governança recomendam revisar quem tem acesso a quê pelo menos a cada 3 meses.`; return; }
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const daysSince = Math.round((today - lastDate) / 86400000);
            if(daysSince <= 90) el.textContent = `Última revisão de acesso: ${lastReview} (há ${daysSince} dia${daysSince === 1 ? '' : 's'}).`;
            else el.innerHTML = `<span style="color: var(--danger);">Faz ${daysSince} dias desde a última revisão de acesso</span> — mais que o trimestre recomendado. Vale conferir quem ainda deveria ter acesso.`;
        }

        function markAccessReviewed() {
            if(!appDB.lastAccessReview) appDB.lastAccessReview = {};
            appDB.lastAccessReview[appDB.currentCompanyId] = getTodayDate();
            saveToCloud();
            renderAccessReviewNote();
            showToast('Revisão de acesso registrada.');
        }

        function renderSettingsAuditLog() {
            const container = document.getElementById('settings-audit-log-body');
            if(!container) return;
            const log = (appDB.auditLog && appDB.auditLog[appDB.currentCompanyId]) || [];
            if(log.length === 0) { container.innerHTML = '<p class="support-note" style="margin:0;">Nenhuma alteração registrada ainda.</p>'; return; }
            const actionLabels = { create: 'criou', edit: 'editou', delete: 'excluiu' };
            const entityLabels = { transaction: 'lançamento', category: 'categoria', vault: 'documento do cofre' };
            const rows = log.slice().reverse().slice(0, 20).map(e => {
                const when = new Date(e.ts);
                const whenLabel = isNaN(when.getTime()) ? e.ts : when.toLocaleString('pt-BR');
                return `<tr><td>${escapeHtml(whenLabel)}</td><td>${escapeHtml(e.user)}</td><td>${actionLabels[e.action] || e.action} ${entityLabels[e.entity] || e.entity}: ${escapeHtml(String(e.entityLabel || ''))}</td></tr>`;
            }).join('');
            container.innerHTML = `<table><thead><tr><th>data</th><th>quem</th><th>alteração</th></tr></thead><tbody>${rows}</tbody></table>`;
        }

        function downloadMyDataJSON() {
            const exportData = {
                exportedAt: new Date().toISOString(),
                company: appDB.companies.find(c => c.id === appDB.currentCompanyId) || null,
                transactions: appDB.transactions ? appDB.transactions[appDB.currentCompanyId] || [] : [],
                spreadsheets: appDB.spreadsheets ? appDB.spreadsheets[appDB.currentCompanyId] || [] : [],
                vault: (appDB.vault ? appDB.vault[appDB.currentCompanyId] || [] : []).map(d => ({ name: d.name, category: d.category, date: d.date, expiry: d.expiry })),
                customCategories: appDB.customCategories ? appDB.customCategories[appDB.currentCompanyId] || [] : [],
                auditLog: appDB.auditLog ? appDB.auditLog[appDB.currentCompanyId] || [] : []
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `LUPPUS_meus_dados_${Date.now()}.json`;
            link.click();
            URL.revokeObjectURL(url);
            showToast('Download dos seus dados iniciado.');
        }

        function requestAccountErasure() {
            if(!confirm('Isso vai apagar permanentemente todos os lançamentos, planilhas e documentos desta conta. Não pode ser desfeito. Continuar?')) return;
            if(!confirm('Tem certeza mesmo? Essa é a última confirmação antes da exclusão definitiva.')) return;
            if(!cloudDB || !currentDocId) { showToast('Não foi possível identificar a conta para exclusão.'); return; }

            cloudDB.collection("luppus_system").doc(currentDocId).delete()
                .then(() => {
                    const authApp = firebase.apps.find(a => a.name === AUTH_APP_NAME);
                    const user = authApp && authApp.auth().currentUser;
                    if(user) {
                        return user.delete().catch(() => {
                            showToast('Dados excluídos. Não foi possível remover o login automaticamente — faça login novamente e exclua a conta em Configurações se necessário, ou fale com o suporte.');
                        });
                    }
                })
                .then(() => { showToast('Conta e dados excluídos.'); setTimeout(() => doLogout(), 1500); })
                .catch(() => showToast('Falha ao excluir os dados. Tente novamente.'));
        }

        // --- SMART SEARCH (AI LITE) ---
        let auditSortColumn = 'date';
        let auditSortDir = 'desc';
        let auditNoAttachmentOnly = false;
        let auditMaterialityOnly = false;
        let lastAuditFilteredData = [];

        const DEFAULT_CATEGORIES = ['Marketing', 'Folha de Pagamento', 'Impostos', 'Infraestrutura', 'Consultoria', 'Vendas', 'Outro'];

        function getCategories() {
            if(!appDB.customCategories) appDB.customCategories = {};
            const custom = appDB.customCategories[appDB.currentCompanyId] || [];
            return DEFAULT_CATEGORIES.concat(custom);
        }

        function renderCategoryUI() {
            const chipContainer = document.getElementById('category-chip-list');
            if(chipContainer) {
                const custom = (appDB.customCategories && appDB.customCategories[appDB.currentCompanyId]) || [];
                const baseHtml = DEFAULT_CATEGORIES.map(c => `<span class="chip">${c}</span>`).join('');
                const customHtml = custom.map((c, i) => `<span class="chip">${escapeHtml(c)}<button type="button" class="chip-remove" onclick="removeCategory(${i})" aria-label="remover categoria ${escapeHtml(c)}">×</button></span>`).join('');
                chipContainer.innerHTML = baseHtml + customHtml;
            }

            const select = document.getElementById('entry-category');
            if(select) {
                const currentValue = select.value;
                const options = getCategories().map(c => `<option${c === currentValue ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
                select.innerHTML = '<option value="">sem categoria</option>' + options;
            }
        }

        function addCategory() {
            const input = document.getElementById('new-category-input');
            const name = input.value.trim();
            if(!name) { showToast('Digite o nome da categoria.'); return; }
            if(getCategories().some(c => c.toLowerCase() === name.toLowerCase())) { showToast('Essa categoria já existe.'); return; }
            if(!appDB.customCategories) appDB.customCategories = {};
            if(!appDB.customCategories[appDB.currentCompanyId]) appDB.customCategories[appDB.currentCompanyId] = [];
            appDB.customCategories[appDB.currentCompanyId].push(name);
            logAudit('category', 'create', name, null, name);
            saveToCloud();
            input.value = '';
            renderCategoryUI();
            showToast('Categoria adicionada.');
        }

        function removeCategory(index) {
            const custom = appDB.customCategories[appDB.currentCompanyId] || [];
            const removedName = custom[index];
            custom.splice(index, 1);
            logAudit('category', 'delete', removedName, removedName, null);
            saveToCloud();
            renderCategoryUI();
            showToast('Categoria removida.');
        }

        function applySmartSearch() {
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(runAuditFilter, 300);
        }

        function runAuditFilter() {
            const query = (document.getElementById('smart-search') ? document.getElementById('smart-search').value : '').toLowerCase();
            let filterType = 'all';
            let filterDesc = query;

            if(query.includes('custo') || query.includes('saida') || query.includes('saída') || query.includes('despesa')) {
                filterType = 'out';
                filterDesc = filterDesc.replace(/(custos?|saídas?|saida?|despesas?|apenas)/g, '').trim();
            } else if(query.includes('receita') || query.includes('entrada') || query.includes('ganho')) {
                filterType = 'in';
                filterDesc = filterDesc.replace(/(receitas?|entradas?|ganhos?|apenas)/g, '').trim();
            }

            filterDesc = filterDesc.replace(/com|de|no|o|a/g, '').trim();

            const dateFromEl = document.getElementById('audit-date-from');
            const dateToEl = document.getElementById('audit-date-to');
            const dateFrom = dateFromEl ? parseBRDate(dateFromEl.value) : null;
            const dateTo = dateToEl ? parseBRDate(dateToEl.value) : null;

            const materialityRaw = document.getElementById('audit-materiality') ? document.getElementById('audit-materiality').value : '';
            const materialityThreshold = materialityRaw === '' ? null : parseFloat(materialityRaw);
            const hasMateriality = materialityThreshold !== null && !isNaN(materialityThreshold);

            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const withIndex = currentTx.map((t, i) => ({ ...t, originalIndex: i }));

            let filteredData = withIndex.filter(t => {
                if(!t.desc.toLowerCase().includes(filterDesc)) return false;
                if(filterType !== 'all' && t.type !== filterType) return false;
                if(auditNoAttachmentOnly && t.receipt) return false;
                if(auditMaterialityOnly && hasMateriality && t.amount < materialityThreshold) return false;
                const td = parseBRDate(t.date);
                if(dateFrom && td && td < dateFrom) return false;
                if(dateTo && td && td > dateTo) return false;
                return true;
            });

            filteredData.sort((a, b) => {
                let cmp = 0;
                if(auditSortColumn === 'date') {
                    const da = a.date.split('/').reverse().join(''); const db = b.date.split('/').reverse().join('');
                    cmp = da.localeCompare(db);
                } else if(auditSortColumn === 'desc') {
                    cmp = a.desc.localeCompare(b.desc);
                } else if(auditSortColumn === 'type') {
                    cmp = a.type.localeCompare(b.type);
                } else if(auditSortColumn === 'amount') {
                    cmp = a.amount - b.amount;
                }
                return auditSortDir === 'asc' ? cmp : -cmp;
            });

            lastAuditFilteredData = filteredData;
            renderData(filteredData);
            renderAuditSummary(filteredData);
            renderAuditSortIndicators();
            renderVarianceReport();
            renderOutliers();
            renderBenfordCheck();
            renderAgingWorklist();
        }

        function toggleAuditMaterialityOnly() {
            auditMaterialityOnly = !auditMaterialityOnly;
            const chip = document.getElementById('audit-chip-materiality');
            if(chip) chip.classList.toggle('active', auditMaterialityOnly);
            runAuditFilter();
        }

        function renderVarianceReport() {
            const el = document.getElementById('audit-variance-body');
            if(!el) return;
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const now = new Date();
            const thisMonthKey = now.getFullYear() + '-' + now.getMonth();
            const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const lastMonthKey = lastMonthDate.getFullYear() + '-' + lastMonthDate.getMonth();
            const sums = {};
            currentTx.forEach(t => {
                if(!t.receipt) return;
                const d = parseBRDate(t.date);
                if(!d) return;
                const key = d.getFullYear() + '-' + d.getMonth();
                if(key !== thisMonthKey && key !== lastMonthKey) return;
                if(!sums[key]) sums[key] = { in: 0, out: 0 };
                if(t.type === 'in') sums[key].in += t.amount; else sums[key].out += t.amount;
            });
            const cur = sums[thisMonthKey] || { in: 0, out: 0 };
            const prev = sums[lastMonthKey] || { in: 0, out: 0 };
            const pctChange = (a, b) => b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / Math.abs(b)) * 100;
            const rows = [
                { label: 'receitas', cur: cur.in, prev: prev.in, higherIsBad: false },
                { label: 'custos', cur: cur.out, prev: prev.out, higherIsBad: true },
                { label: 'líquido', cur: cur.in - cur.out, prev: prev.in - prev.out, higherIsBad: false }
            ];
            el.innerHTML = rows.map(r => {
                const pct = pctChange(r.cur, r.prev);
                const isGood = r.higherIsBad ? pct <= 0 : pct >= 0;
                const pctColor = isGood ? 'var(--success)' : 'var(--danger)';
                const arrow = pct >= 0 ? '▲' : '▼';
                return `<div class="variance-row"><span style="text-transform:capitalize;">${r.label}</span><span>R$ ${r.cur.toLocaleString('pt-BR',{minimumFractionDigits:2})} <span style="color:${pctColor}; font-size:10px;">${arrow} ${Math.abs(pct).toFixed(1)}% vs. mês anterior</span></span></div>`;
            }).join('');
        }

        function renderOutliers() {
            const el = document.getElementById('audit-outliers-body');
            if(!el) return;
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const byCategory = {};
            currentTx.forEach((t, i) => {
                if(!t.receipt) return;
                const cat = t.category || '(sem categoria)';
                if(!byCategory[cat]) byCategory[cat] = [];
                byCategory[cat].push({ ...t, originalIndex: i });
            });
            let outliers = [];
            Object.keys(byCategory).forEach(cat => {
                const items = byCategory[cat];
                if(items.length < 4) return;
                const amounts = items.map(t => t.amount);
                const mean = amounts.reduce((a,b) => a+b, 0) / amounts.length;
                const variance = amounts.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / amounts.length;
                const std = Math.sqrt(variance);
                if(std === 0) return;
                items.forEach(t => {
                    const z = (t.amount - mean) / std;
                    if(Math.abs(z) >= 2.5) outliers.push({ ...t, z });
                });
            });
            outliers.sort((a,b) => Math.abs(b.z) - Math.abs(a.z));
            if(outliers.length === 0) { el.innerHTML = '<p class="support-note" style="margin:0;">Nenhum lançamento fora do padrão estatístico da própria categoria.</p>'; return; }
            el.innerHTML = outliers.slice(0, 8).map(t => `<div class="outlier-row"><span>${escapeHtml(t.desc)} <span style="color:var(--text-muted); font-size:10px;">(${escapeHtml(t.category||'sem categoria')}, ${t.date})</span></span><span style="color:var(--danger);">R$ ${t.amount.toLocaleString('pt-BR',{minimumFractionDigits:2})} · ${Math.abs(t.z).toFixed(1)}σ da média</span></div>`).join('');
        }

        let benfordChartInstance = null;
        const BENFORD_EXPECTED = [30.1,17.6,12.5,9.7,7.9,6.7,5.8,5.1,4.6];

        function renderBenfordCheck() {
            const canvas = document.getElementById('benfordChart');
            const verdictEl = document.getElementById('benford-verdict');
            if(!canvas) return;
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const amounts = currentTx.filter(t => t.receipt).map(t => t.amount).filter(a => a > 0);
            if(amounts.length < 30) {
                if(verdictEl) verdictEl.textContent = `É preciso de pelo menos 30 lançamentos confirmados para essa checagem fazer sentido estatisticamente (hoje: ${amounts.length}).`;
                if(benfordChartInstance) { benfordChartInstance.destroy(); benfordChartInstance = null; }
                return;
            }
            const counts = new Array(9).fill(0);
            amounts.forEach(a => {
                const s = String(Math.abs(a)).replace(/^0+/, '').replace('.', '');
                const firstDigit = parseInt(s[0], 10);
                if(firstDigit >= 1 && firstDigit <= 9) counts[firstDigit - 1]++;
            });
            const total = counts.reduce((a,b) => a+b, 0);
            const observed = counts.map(c => (c / total) * 100);
            const deviation = observed.reduce((sum, obs, i) => sum + Math.abs(obs - BENFORD_EXPECTED[i]), 0) / 9;

            const ctx = canvas.getContext('2d');
            if(benfordChartInstance) benfordChartInstance.destroy();
            benfordChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['1','2','3','4','5','6','7','8','9'],
                    datasets: [
                        { label: 'Observado', data: observed, backgroundColor: cssVarAlpha('--champagne', 0.6) },
                        { label: 'Esperado (Benford)', type: 'line', data: BENFORD_EXPECTED, borderColor: cssVar('--text-muted'), borderDash: [4,4], pointRadius: 0, fill: false }
                    ]
                },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { grid: { color: cssVar('--border') }, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } } }
            });

            if(verdictEl) {
                if(deviation < 3) verdictEl.innerHTML = `Distribuição próxima do esperado (desvio médio ${deviation.toFixed(1)} pontos) — sem sinal de anomalia.`;
                else if(deviation < 6) verdictEl.innerHTML = `<span style="color:var(--gold);">Desvio moderado (${deviation.toFixed(1)} pontos)</span> — vale uma olhada, mas pode ser só o perfil natural dos seus lançamentos.`;
                else verdictEl.innerHTML = `<span style="color:var(--danger);">Desvio alto (${deviation.toFixed(1)} pontos)</span> — a distribuição foge bastante do padrão esperado, considere revisar os valores lançados manualmente.`;
            }
        }

        function renderAgingWorklist() {
            const el = document.getElementById('audit-aging-body');
            if(!el) return;
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const today = new Date(); today.setHours(0,0,0,0);
            const pending = currentTx
                .map((t, i) => ({ ...t, originalIndex: i }))
                .filter(t => !t.receipt)
                .map(t => { const d = parseBRDate(t.date); const days = d ? Math.max(0, Math.round((today - d) / 86400000)) : 0; return { ...t, days }; })
                .sort((a, b) => b.days - a.days);
            if(pending.length === 0) { el.innerHTML = '<p class="support-note" style="margin:0;">Nenhuma pendência sem comprovante.</p>'; return; }
            el.innerHTML = pending.slice(0, 10).map(t => {
                const color = t.days > 30 ? 'var(--danger)' : (t.days > 7 ? 'var(--gold)' : 'var(--text-muted)');
                return `<div class="aging-row"><span>${escapeHtml(t.desc)} <span style="color:var(--text-muted); font-size:10px;">(${t.date})</span></span><span style="color:${color};">${t.days} dia${t.days===1?'':'s'} pendente</span></div>`;
            }).join('');
        }

        function renderAuditSummary(data) {
            const el = document.getElementById('audit-filter-summary');
            if(!el) return;
            let totalIn = 0, totalOut = 0, pendingCount = 0;
            data.forEach(t => {
                if(!t.receipt) { pendingCount++; return; }
                if(t.type === 'in') totalIn += t.amount; else totalOut += t.amount;
            });
            const net = totalIn - totalOut;
            const netColor = net >= 0 ? 'var(--success)' : 'var(--danger)';
            const pendingHtml = pendingCount > 0 ? ` · <span style="color: var(--danger);">${pendingCount} pendente${pendingCount === 1 ? '' : 's'} (não contabilizado${pendingCount === 1 ? '' : 's'})</span>` : '';
            el.innerHTML = `${data.length} lançamento${data.length === 1 ? '' : 's'} · <span style="color: var(--success);">receitas R$ ${totalIn.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span> · <span style="color: var(--danger);">custos R$ ${totalOut.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span> · <span style="color: ${netColor};">líquido R$ ${net.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>${pendingHtml}`;
        }

        function renderAuditSortIndicators() {
            document.querySelectorAll('#history-table th[data-sort]').forEach(th => {
                th.classList.remove('sorted-asc', 'sorted-desc');
                if(th.dataset.sort === auditSortColumn) th.classList.add(auditSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
            });
        }

        function setAuditSort(col) {
            if(auditSortColumn === col) { auditSortDir = auditSortDir === 'asc' ? 'desc' : 'asc'; }
            else { auditSortColumn = col; auditSortDir = col === 'date' ? 'desc' : 'asc'; }
            runAuditFilter();
        }

        function toggleAuditNoAttachment() {
            auditNoAttachmentOnly = !auditNoAttachmentOnly;
            const chip = document.getElementById('audit-chip-no-attachment');
            if(chip) chip.classList.toggle('active', auditNoAttachmentOnly);
            runAuditFilter();
        }

        function setAuditQuickFilter(type) {
            const searchEl = document.getElementById('smart-search');
            const fromEl = document.getElementById('audit-date-from');
            const toEl = document.getElementById('audit-date-to');
            if(type === 'receitas') { searchEl.value = 'apenas receitas'; }
            else if(type === 'custos') { searchEl.value = 'apenas custos'; }
            else if(type === 'ultimos30') {
                const d = new Date(); d.setDate(d.getDate() - 30);
                fromEl.value = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
                toEl.value = '';
            }
            runAuditFilter();
        }

        function clearAuditFilters() {
            document.getElementById('smart-search').value = '';
            document.getElementById('audit-date-from').value = '';
            document.getElementById('audit-date-to').value = '';
            auditNoAttachmentOnly = false;
            const chip = document.getElementById('audit-chip-no-attachment'); if(chip) chip.classList.remove('active');
            auditSortColumn = 'date'; auditSortDir = 'desc';
            runAuditFilter();
        }

        async function sha256Hex(str) {
            const data = new TextEncoder().encode(str);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        async function exportAuditCSV() {
            if(!lastAuditFilteredData || lastAuditFilteredData.length === 0) { showToast("Nada para exportar."); return; }
            const header = ['Data', 'Descrição', 'Natureza', 'Valor'];
            const rows = lastAuditFilteredData.map(t => [t.date, t.desc.replace(/;/g, ','), t.type === 'in' ? 'Receita' : 'Custo', t.amount.toFixed(2).replace('.', ',')]);
            const csvBody = [header, ...rows].map(r => r.join(';')).join('\r\n');
            const hash = await sha256Hex(csvBody);
            const csv = csvBody + '\r\n\r\n;;;\r\nSHA-256 deste conteúdo (para conferência de integridade);' + hash;
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `luppus_auditoria_${Date.now()}.csv`;
            link.click();
            URL.revokeObjectURL(url);
            const noteEl = document.getElementById('audit-checksum-note');
            if(noteEl) { noteEl.style.display = 'block'; noteEl.textContent = `Checksum SHA-256 deste export (também incluído no rodapé do CSV): ${hash}`; }
        }

        // --- RENDER TABLE & CHART ---
        function renderData(dataToRender) {
            let totalIn = 0, totalOut = 0, pendingSum = 0;
            const tbody = document.querySelector('#history-table tbody');
            const recentList = document.getElementById('recent-transactions-list');

            if(tbody) tbody.innerHTML = '';
            if(recentList) recentList.innerHTML = '';

            dataToRender.forEach((t, index) => {
                const isPending = !t.receipt;
                if(!isPending) {
                    if(t.type === 'in') totalIn += t.amount;
                    if(t.type === 'out') totalOut += t.amount;
                } else {
                    pendingSum += (t.type === 'in' ? t.amount : -t.amount);
                }

                let attachmentHtml = '<span style="color: var(--text-muted);">-</span>';
                if (t.receipt) { attachmentHtml = `<a href="${t.receipt.data}" download="${t.receipt.name}" class="attachment-link">doc</a>`; }

                const categoryChip = t.category ? ` <span class="chip" style="padding: 2px 8px; font-size: 9px; vertical-align: middle;">${escapeHtml(t.category)}</span>` : '';
                const pendingChip = isPending ? ` <span class="chip chip-danger" style="padding: 2px 8px; font-size: 9px; vertical-align: middle;">pendente</span>` : '';

                if(tbody) {
                    const tr = document.createElement('tr');
                    let actionHtml = '';
                    let checkboxHtml = '';
                    if(!isClientMode) {
                        actionHtml = `<div style="display:flex; gap:6px;">
                            <button class="icon-btn" onclick="editTransaction(${t.originalIndex})" aria-label="editar lançamento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                            <button class="icon-btn" onclick="deleteTransaction(${t.originalIndex})" aria-label="excluir lançamento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </div>`;
                        checkboxHtml = `<input type="checkbox" class="bulk-row-checkbox" ${bulkSelectedIndices.has(t.originalIndex) ? 'checked' : ''} onchange="toggleBulkRow(${t.originalIndex}, this.checked)" aria-label="selecionar lançamento">`;
                    }
                    tr.innerHTML = `
                        <td class="hide-on-pdf hide-client">${checkboxHtml}</td>
                        <td style="color: var(--text-muted);">${t.date}</td>
                        <td>${escapeHtml(t.desc)}${categoryChip}${pendingChip}</td>
                        <td style="color: ${t.type === 'in' ? 'var(--success)' : 'var(--danger)'};">${t.type === 'in' ? 'receita' : 'custo'}</td>
                        <td>R$ ${t.amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                        <td class="hide-on-pdf">${attachmentHtml}</td>
                        <td class="hide-on-pdf hide-client">${actionHtml}</td>
                    `;
                    tbody.appendChild(tr);
                }

                if(recentList && index < 5) {
                    const li = document.createElement('li');
                    li.className = 'recent-item';
                    li.innerHTML = `<span class="recent-desc">${escapeHtml(t.desc.substring(0,25))}${pendingChip}</span><span class="recent-val ${t.type}">${t.type === 'in' ? '+' : '-'}R$ ${t.amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>`;
                    recentList.appendChild(li);
                }
            });

            if(dataToRender.length === 0) {
                if(recentList) recentList.innerHTML = '<li class="empty-state">Sem lançamentos ainda.</li>';
                if(tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhum lançamento registrado ainda.</td></tr>';
            }
            updateBulkActionsBar();

            const elIn = document.getElementById('total-in'); const elOut = document.getElementById('total-out'); const elNet = document.getElementById('net-cash');
            if(elIn) elIn.innerText = `R$ ${totalIn.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            if(elOut) elOut.innerText = `R$ ${totalOut.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            if(elNet) {
                elNet.innerText = `R$ ${(totalIn - totalOut).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
                elNet.style.color = (totalIn - totalOut) >= 0 ? 'var(--success)' : 'var(--danger)';
            }
            const elNetSub = document.getElementById('net-cash-subtitle');
            if(elNetSub) {
                elNetSub.textContent = pendingSum !== 0 ? `confirmado — R$ ${Math.abs(pendingSum).toLocaleString('pt-BR',{minimumFractionDigits:2})} ${pendingSum >= 0 ? 'a receber' : 'a pagar'} ainda pendente` : 'todos os lançamentos já confirmados';
            }
            updateChart(totalIn, totalOut);
            if(document.getElementById('view-projecao').classList.contains('active')) updateForecasting();
            updatePainelAlerts();
            updatePainelCategoryChart();
            updatePainelForecastSummary();
            updatePainelRunway();
            updatePainelInsight(totalIn, totalOut);
        }

        function goToAuditFilteredByType(type) {
            switchView('relatorios');
            if(type === 'in') setAuditQuickFilter('receitas');
            else if(type === 'out') setAuditQuickFilter('custos');
            else clearAuditFilters();
        }

        function updatePainelRunway() {
            const el = document.getElementById('painel-runway');
            if(!el) return;
            const currentTx = (appDB.transactions[appDB.currentCompanyId] || []).filter(t => t.receipt);
            if(currentTx.length === 0) { el.textContent = '--'; el.style.color = ''; return; }
            let totalIn = 0, totalOut = 0, oldestDate = null;
            currentTx.forEach(t => {
                if(t.type === 'in') totalIn += t.amount; else totalOut += t.amount;
                const d = parseBRDate(t.date);
                if(d && (!oldestDate || d < oldestDate)) oldestDate = d;
            });
            const currentCash = totalIn - totalOut;
            const today = new Date(); today.setHours(0,0,0,0);
            const daysCovered = oldestDate ? Math.max(1, Math.round((today - oldestDate) / 86400000)) : 1;
            const dailyNet = (totalIn - totalOut) / daysCovered;
            if(dailyNet >= 0) { el.textContent = 'sem queima'; el.style.color = 'var(--success)'; return; }
            if(currentCash <= 0) { el.textContent = '0 meses'; el.style.color = 'var(--danger)'; return; }
            const monthlyBurn = Math.abs(dailyNet) * 30;
            const months = currentCash / monthlyBurn;
            el.textContent = months >= 12 ? `${(months/12).toFixed(1)} anos` : `${months.toFixed(1)} meses`;
            el.style.color = months < 3 ? 'var(--danger)' : (months < 6 ? 'var(--gold)' : 'var(--success)');
        }

        function updatePainelInsight(totalIn, totalOut) {
            const el = document.getElementById('painel-insight');
            if(!el) return;
            const currentTx = (appDB.transactions[appDB.currentCompanyId] || []).filter(t => t.receipt && t.type === 'out');
            if(currentTx.length === 0) { el.textContent = ''; return; }

            const now = new Date();
            const thisMonthKey = now.getFullYear() + '-' + now.getMonth();
            const grouped = {};
            currentTx.forEach(t => {
                const cat = t.category || 'sem categoria';
                if(!grouped[cat]) grouped[cat] = 0;
                grouped[cat] += t.amount;
            });
            const topCat = Object.keys(grouped).sort((a,b) => grouped[b] - grouped[a])[0];
            if(!topCat || totalOut === 0) { el.textContent = ''; return; }
            const pct = (grouped[topCat] / totalOut) * 100;

            const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const lastMonthKey = lastMonthDate.getFullYear() + '-' + lastMonthDate.getMonth();
            let thisMonthCatTotal = 0, lastMonthCatTotal = 0;
            currentTx.forEach(t => {
                if((t.category || 'sem categoria') !== topCat) return;
                const d = parseBRDate(t.date);
                if(!d) return;
                const key = d.getFullYear() + '-' + d.getMonth();
                if(key === thisMonthKey) thisMonthCatTotal += t.amount;
                else if(key === lastMonthKey) lastMonthCatTotal += t.amount;
            });

            let trendPhrase = '';
            if(lastMonthCatTotal > 0) {
                const change = ((thisMonthCatTotal - lastMonthCatTotal) / lastMonthCatTotal) * 100;
                if(Math.abs(change) >= 5) trendPhrase = `, ${change >= 0 ? 'alta' : 'queda'} de ${Math.abs(change).toFixed(0)}% vs. o mês anterior`;
            }
            el.innerHTML = `<strong style="color: var(--text-main); font-style: normal;">${escapeHtml(topCat)}</strong> responde por ${pct.toFixed(0)}% dos seus custos confirmados${trendPhrase}.`;
        }

        function updateChart(totalIn, totalOut) {
            const canvasEl = document.getElementById('cashFlowChart');
            if(!canvasEl) return;
            const ctx = canvasEl.getContext('2d');
            if(chartInstance) chartInstance.destroy();
            
            chartInstance = new Chart(ctx, {
                type: 'bar',
                data: { labels: ['Volume'], datasets: [{ label: 'Receitas', data: [totalIn], backgroundColor: verticalGradient(ctx, '--success', 260, 0.9, 0.25), borderRadius: 2 }, { label: 'Custos', data: [totalOut], backgroundColor: verticalGradient(ctx, '--danger', 260, 0.9, 0.25), borderRadius: 2 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, grid: {color: cssVar('--border'), drawBorder: false} }, x: { display: false, grid: {display: false} } }, plugins: { legend: { display: false } } }
            });
        }

        // --- PAINEL: ALERTAS, CATEGORIAS E RESUMO DE PROJEÇÃO ---
        function goToPendingTransactions() {
            switchView('relatorios');
            auditNoAttachmentOnly = true;
            const chip = document.getElementById('audit-chip-no-attachment');
            if(chip) chip.classList.add('active');
            runAuditFilter();
        }

        function updatePainelAlerts() {
            const container = document.getElementById('painel-alerts-grid');
            if(!container) return;

            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const pendingCount = currentTx.filter(t => !t.receipt).length;

            const docs = (appDB.vault && appDB.vault[appDB.currentCompanyId]) ? appDB.vault[appDB.currentCompanyId] : [];
            const today = new Date(); today.setHours(0,0,0,0);
            let expiringCount = 0;
            docs.forEach(d => {
                const expDate = parseBRDate(d.expiry);
                if(!expDate) return;
                const diffDays = Math.round((expDate - today) / 86400000);
                if(diffDays <= 30) expiringCount++;
            });

            let outlierCount = 0;
            const byCategory = {};
            currentTx.filter(t => t.receipt).forEach(t => {
                const cat = t.category || '(sem categoria)';
                if(!byCategory[cat]) byCategory[cat] = [];
                byCategory[cat].push(t.amount);
            });
            Object.keys(byCategory).forEach(cat => {
                const amounts = byCategory[cat];
                if(amounts.length < 4) return;
                const mean = amounts.reduce((a,b) => a+b, 0) / amounts.length;
                const std = Math.sqrt(amounts.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / amounts.length);
                if(std === 0) return;
                amounts.forEach(a => { if(Math.abs((a - mean) / std) >= 2.5) outlierCount++; });
            });

            const pendingClass = pendingCount > 0 ? 'has-issues' : '';
            const expiringClass = expiringCount > 0 ? 'has-issues' : '';
            const outlierClass = outlierCount > 0 ? 'has-issues' : '';

            container.innerHTML = `
                <button type="button" class="painel-alert-item ${pendingClass}" onclick="goToPendingTransactions()">
                    <span class="painel-alert-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></span>
                    <span class="painel-alert-text"><strong>${pendingCount} lançamento${pendingCount === 1 ? '' : 's'} pendente${pendingCount === 1 ? '' : 's'}</strong><span>${pendingCount > 0 ? 'aguardando comprovante — não contam nos totais' : 'tudo contabilizado'}</span></span>
                </button>
                <button type="button" class="painel-alert-item ${expiringClass}" onclick="switchView('cofre')">
                    <span class="painel-alert-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span>
                    <span class="painel-alert-text"><strong>${expiringCount} documento${expiringCount === 1 ? '' : 's'} vencendo</strong><span>${expiringCount > 0 ? 'nos próximos 30 dias' : 'nenhum vencimento próximo'}</span></span>
                </button>
                <button type="button" class="painel-alert-item ${outlierClass}" onclick="switchView('relatorios')">
                    <span class="painel-alert-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></span>
                    <span class="painel-alert-text"><strong>${outlierCount} lançamento${outlierCount === 1 ? '' : 's'} fora do padrão</strong><span>${outlierCount > 0 ? 'valor muito acima da média da categoria' : 'nada fora do padrão estatístico'}</span></span>
                </button>
            `;
        }

        function updatePainelCategoryChart() {
            const canvas = document.getElementById('categoryChart');
            const emptyEl = document.getElementById('category-chart-empty');
            const layoutEl = document.getElementById('category-breakdown-layout');
            const listEl = document.getElementById('category-breakdown-list');
            if(!canvas) return;

            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const grouped = {};
            currentTx.forEach(t => {
                if(!t.receipt || t.type !== 'out') return;
                const cat = t.category || 'Sem categoria';
                if(!grouped[cat]) grouped[cat] = { total: 0, count: 0 };
                grouped[cat].total += t.amount;
                grouped[cat].count++;
            });
            const entries = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);

            if(entries.length === 0) {
                if(emptyEl) emptyEl.style.display = 'block';
                if(layoutEl) layoutEl.style.display = 'none';
                if(categoryChartInstance) { categoryChartInstance.destroy(); categoryChartInstance = null; }
                return;
            }
            if(emptyEl) emptyEl.style.display = 'none';
            if(layoutEl) layoutEl.style.display = 'flex';

            const labels = entries.map(e => e[0]);
            const values = entries.map(e => e[1].total);
            const grandTotal = values.reduce((sum, v) => sum + v, 0);
            const colors = categoricalPalette(labels.length);

            const ctx = canvas.getContext('2d');
            if(categoryChartInstance) categoryChartInstance.destroy();
            categoryChartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderColor: cssVar('--card-bg'), borderWidth: 2 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '65%', plugins: { legend: { display: false } } }
            });

            if(listEl) {
                listEl.innerHTML = entries.map(([cat, data], i) => {
                    const pct = grandTotal > 0 ? (data.total / grandTotal * 100) : 0;
                    return `
                        <li class="category-breakdown-item">
                            <span class="category-breakdown-dot" style="background: ${colors[i]};"></span>
                            <span class="category-breakdown-info"><strong>${escapeHtml(cat)}</strong><span>${data.count} lançamento${data.count === 1 ? '' : 's'}</span></span>
                            <span class="category-breakdown-value"><strong>R$ ${data.total.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</strong><span>${pct.toFixed(1)}% do total</span></span>
                        </li>
                    `;
                }).join('');
            }
        }

        function updatePainelForecastSummary() {
            const el = document.getElementById('painel-forecast-30');
            if(!el) return;
            const currentTx = (appDB.transactions[appDB.currentCompanyId] || []).filter(t => t.receipt);
            if(currentTx.length === 0) { el.textContent = 'R$ 0,00'; el.style.color = ''; return; }

            let totalIn = 0, totalOut = 0, oldestDate = null;
            currentTx.forEach(t => {
                if(t.type === 'in') totalIn += t.amount; else totalOut += t.amount;
                const d = parseBRDate(t.date);
                if(d && (!oldestDate || d < oldestDate)) oldestDate = d;
            });
            const currentCash = totalIn - totalOut;
            const today = new Date(); today.setHours(0,0,0,0);
            const daysCovered = oldestDate ? Math.max(1, Math.round((today - oldestDate) / 86400000)) : 1;
            const dailyNet = (totalIn - totalOut) / daysCovered;
            const projected = currentCash + dailyNet * 30;

            el.textContent = `R$ ${projected.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            el.style.color = projected >= 0 ? 'var(--success)' : 'var(--danger)';
        }

        // --- MOTOR DE PREVISIBILIDADE (FORECASTING) ---
        function updateForecasting() {
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const forecastEmpty = document.getElementById('forecast-empty-state');
            const forecastCanvas = document.getElementById('forecastChart');
            const warningEl = document.getElementById('forecast-threshold-warning');
            if(currentTx.length === 0) {
                if(forecastEmpty) forecastEmpty.style.display = 'block';
                if(forecastCanvas) forecastCanvas.style.display = 'none';
                if(warningEl) warningEl.style.display = 'none';
                return;
            }
            if(forecastEmpty) forecastEmpty.style.display = 'none';
            if(forecastCanvas) forecastCanvas.style.display = 'block';

            const confirmedSorted = currentTx
                .filter(t => t.receipt)
                .map(t => ({ date: parseBRDate(t.date), amount: t.type === 'in' ? t.amount : -t.amount, isIn: t.type === 'in' }))
                .filter(t => t.date)
                .sort((a, b) => a.date - b.date);

            let totalIn = 0, totalOut = 0;
            confirmedSorted.forEach(t => { if(t.isIn) totalIn += t.amount; else totalOut += -t.amount; });
            const currentCash = totalIn - totalOut;
            const oldestDate = confirmedSorted.length ? confirmedSorted[0].date : null;

            const today = new Date(); today.setHours(0,0,0,0);
            const daysCovered = oldestDate ? Math.max(1, Math.round((today - oldestDate) / 86400000)) : 1;
            const dailyAvgIn = totalIn / daysCovered;
            const dailyAvgOut = totalOut / daysCovered;

            const extraCost = parseFloat(document.getElementById('forecast-extra-cost').value) || 0;
            const revenueChangePct = parseFloat(document.getElementById('forecast-revenue-change').value) || 0;
            const adjustedDailyIn = dailyAvgIn * (1 + revenueChangePct / 100);
            const adjustedDailyOut = dailyAvgOut + (extraCost / 30);
            const baseDailyNet = adjustedDailyIn - adjustedDailyOut;
            const optimisticDailyNet = (adjustedDailyIn * 1.15) - adjustedDailyOut;
            const pessimisticDailyNet = (adjustedDailyIn * 0.85) - (adjustedDailyOut * 1.10);

            const horizonRaw = document.getElementById('forecast-horizon').value;
            const isWeeklyMode = horizonRaw === '13w';
            const horizon = isWeeklyMode ? 91 : (parseInt(horizonRaw, 10) || 30);
            const futureSteps = isWeeklyMode ? 13 : 6;

            // --- histórico real (mesma amostragem em pontos que o futuro, terminando hoje) ---
            const historySteps = Math.min(6, daysCovered);
            let histLabels = []; let histValues = [];
            let cumIdx = 0; let running = 0;
            for(let i = 0; i <= historySteps; i++) {
                const dayOffset = Math.round((daysCovered / historySteps) * i);
                const cutoff = new Date(oldestDate || today); cutoff.setDate(cutoff.getDate() + dayOffset);
                while(cumIdx < confirmedSorted.length && confirmedSorted[cumIdx].date <= cutoff) { running += confirmedSorted[cumIdx].amount; cumIdx++; }
                histValues.push(running);
                histLabels.push(dayOffset === daysCovered ? 'Hoje' : `-${daysCovered - dayOffset}d`);
            }
            // garante que o último ponto histórico seja exatamente o caixa atual (arredondamentos de amostragem à parte)
            histValues[histValues.length - 1] = currentCash;

            let futureLabels = []; let futureBase = []; let futureOpt = []; let futurePess = []; let dayOffsets = [];
            for(let i = 1; i <= futureSteps; i++) {
                const day = isWeeklyMode ? Math.round((91 / 13) * i) : Math.round((horizon / futureSteps) * i);
                dayOffsets.push(day);
                futureLabels.push(isWeeklyMode ? `Sem ${i}` : '+' + day + 'd');
                futureBase.push(currentCash + baseDailyNet * day);
                futureOpt.push(currentCash + optimisticDailyNet * day);
                futurePess.push(currentCash + pessimisticDailyNet * day);
            }

            const useMonteCarlo = document.getElementById('forecast-montecarlo-toggle') && document.getElementById('forecast-montecarlo-toggle').checked;
            let futureP10 = null, futureP90 = null;
            if(useMonteCarlo) {
                const dailySeries = computeDailyNetSeries(confirmedSorted, oldestDate, today);
                const mcMean = dailySeries.length ? dailySeries.reduce((a,b) => a+b, 0) / dailySeries.length : baseDailyNet;
                const mcVariance = dailySeries.length ? dailySeries.reduce((a,b) => a + Math.pow(b - mcMean, 2), 0) / dailySeries.length : 0;
                const mcStd = Math.sqrt(mcVariance);
                const percentiles = runMonteCarloSimulation(currentCash, mcMean, mcStd, dayOffsets, 300);
                futureP10 = percentiles.map(p => p.p10);
                futureP90 = percentiles.map(p => p.p90);
            }

            const labels = histLabels.concat(futureLabels);
            const nullPad = new Array(histLabels.length - 1).fill(null);
            const historicalSeries = histValues.concat(new Array(futureLabels.length).fill(null));
            const baseSeries = nullPad.concat([currentCash], futureBase);
            const optSeries = nullPad.concat([currentCash], futureOpt);
            const pessSeries = nullPad.concat([currentCash], futurePess);
            const p10Series = futureP10 ? nullPad.concat([currentCash], futureP10) : null;
            const p90Series = futureP90 ? nullPad.concat([currentCash], futureP90) : null;

            const projectedEnd = futureBase[futureBase.length - 1];
            document.getElementById('forecast-30-label').textContent = isWeeklyMode ? 'saldo projetado (13 sem.)' : `saldo projetado (${horizon}d)`;
            document.getElementById('forecast-30').innerText = `R$ ${projectedEnd.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            document.getElementById('forecast-30').style.color = projectedEnd >= 0 ? 'var(--success)' : 'var(--danger)';

            const riskEl = document.getElementById('forecast-risk');
            const isCritical = projectedEnd < 0;
            if(isCritical) { riskEl.innerText = 'CRÍTICO'; riskEl.style.color = 'var(--danger)'; }
            else if(projectedEnd < (currentCash/2)) { riskEl.innerText = 'MÉDIO'; riskEl.style.color = 'var(--gold)'; }
            else { riskEl.innerText = 'BAIXO'; riskEl.style.color = 'var(--success)'; }
            checkForecastNotifications(isCritical, projectedEnd);

            const thresholdRaw = document.getElementById('forecast-threshold').value;
            const threshold = thresholdRaw === '' ? null : parseFloat(thresholdRaw);
            const hasThreshold = threshold !== null && !isNaN(threshold);

            const ctx = document.getElementById('forecastChart').getContext('2d');
            if(forecastChartInstance) forecastChartInstance.destroy();
            const datasets = [
                { label: 'Histórico', data: historicalSeries, borderColor: cssVar('--text-muted'), backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, spanGaps: false },
                { label: 'Base', data: baseSeries, borderColor: cssVar('--champagne'), backgroundColor: verticalGradient(ctx, '--champagne', 300, 0.30, 0), fill: true, borderDash: [5, 5], tension: 0.3, pointBackgroundColor: cssVar('--champagne'), pointBorderColor: cssVar('--obsidian'), pointRadius: 3, pointHoverRadius: 6, spanGaps: false }
            ];
            if(useMonteCarlo && p10Series && p90Series) {
                datasets.push({ label: 'Faixa provável (P10–P90, Monte Carlo)', data: p90Series, borderColor: 'transparent', backgroundColor: cssVarAlpha('--champagne', 0.12), pointRadius: 0, fill: '+1', spanGaps: false, tension: 0.3 });
                datasets.push({ label: 'P10 (Monte Carlo)', data: p10Series, borderColor: cssVarAlpha('--champagne', 0.45), backgroundColor: 'transparent', pointRadius: 0, borderDash: [1, 3], fill: false, spanGaps: false, tension: 0.3 });
            } else {
                datasets.push({ label: 'Otimista', data: optSeries, borderColor: cssVar('--success'), backgroundColor: 'transparent', fill: false, borderDash: [2, 3], tension: 0.3, pointRadius: 0, spanGaps: false });
                datasets.push({ label: 'Pessimista', data: pessSeries, borderColor: cssVar('--danger'), backgroundColor: 'transparent', fill: false, borderDash: [2, 3], tension: 0.3, pointRadius: 0, spanGaps: false });
            }
            if(hasThreshold) {
                datasets.push({ label: 'Limite Mínimo', data: labels.map(() => threshold), borderColor: cssVar('--danger'), borderDash: [3, 3], pointRadius: 0, fill: false, tension: 0, spanGaps: true });
            }
            forecastChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { grid: {color: cssVar('--border')} }, x: { grid: {display: false} } }, plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } } } }
            });

            if(warningEl) {
                if(hasThreshold && futureBase.some(v => v < threshold)) {
                    warningEl.style.display = 'block';
                    warningEl.textContent = `atenção: o cenário base cruza o limite mínimo de R$ ${threshold.toLocaleString('pt-BR', {minimumFractionDigits: 2})} dentro do horizonte projetado.`;
                } else {
                    warningEl.style.display = 'none';
                }
            }

            updateForecastFreshness();
            renderForecastCategoryBreakdown(horizon, isWeeklyMode, futureSteps, dayOffsets);
        }

        // Devolve o fluxo líquido diário histórico dia a dia (0 nos dias sem lançamento) —
        // é a base para calcular a volatilidade usada na simulação de Monte Carlo.
        function localDateKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

        function computeDailyNetSeries(confirmedSorted, oldestDate, today) {
            if(!oldestDate) return [];
            const byDay = {};
            confirmedSorted.forEach(t => {
                const key = localDateKey(t.date);
                byDay[key] = (byDay[key] || 0) + t.amount;
            });
            const series = [];
            const cursor = new Date(oldestDate);
            while(cursor <= today) {
                series.push(byDay[localDateKey(cursor)] || 0);
                cursor.setDate(cursor.getDate() + 1);
            }
            return series;
        }

        // Box-Muller — gera um número aleatório com distribuição normal (média 0, desvio 1).
        function gaussianRandom() {
            let u = 0, v = 0;
            while(u === 0) u = Math.random();
            while(v === 0) v = Math.random();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        }

        // Roda N simulações de caminho aleatório (fluxo diário ~ Normal(média, desvio) observado no
        // histórico real) e devolve os percentis 10/50/90 do saldo em cada dia de interesse.
        function runMonteCarloSimulation(startCash, meanDaily, stdDaily, dayOffsets, numSims) {
            const maxDay = Math.max.apply(null, dayOffsets);
            const results = dayOffsets.map(() => []);
            for(let sim = 0; sim < numSims; sim++) {
                let cash = startCash;
                let pointer = 0;
                for(let day = 1; day <= maxDay; day++) {
                    cash += meanDaily + stdDaily * gaussianRandom();
                    while(pointer < dayOffsets.length && dayOffsets[pointer] === day) {
                        results[pointer].push(cash);
                        pointer++;
                    }
                }
            }
            return results.map(arr => {
                arr.sort((a, b) => a - b);
                const pick = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
                return { p10: pick(0.10), p50: pick(0.50), p90: pick(0.90) };
            });
        }

        function renderForecastCategoryBreakdown(horizon, isWeeklyMode, futureSteps, dayOffsets) {
            const canvas = document.getElementById('forecastCategoryChart');
            const emptyEl = document.getElementById('forecast-category-empty');
            if(!canvas) return;
            const currentTx = (appDB.transactions[appDB.currentCompanyId] || []).filter(t => t.receipt && t.type === 'out');
            const byCategory = {};
            currentTx.forEach(t => {
                const cat = t.category || 'sem categoria';
                const d = parseBRDate(t.date);
                if(!d) return;
                if(!byCategory[cat]) byCategory[cat] = { total: 0, oldest: d };
                byCategory[cat].total += t.amount;
                if(d < byCategory[cat].oldest) byCategory[cat].oldest = d;
            });
            const cats = Object.keys(byCategory).filter(c => byCategory[c].total > 0);
            if(cats.length < 2) {
                if(emptyEl) emptyEl.style.display = 'block';
                canvas.style.display = 'none';
                if(forecastCategoryChartInstance) { forecastCategoryChartInstance.destroy(); forecastCategoryChartInstance = null; }
                return;
            }
            if(emptyEl) emptyEl.style.display = 'none';
            canvas.style.display = 'block';

            const today = new Date(); today.setHours(0, 0, 0, 0);
            cats.sort((a, b) => byCategory[b].total - byCategory[a].total);
            const topCats = cats.slice(0, 6);
            const labels = dayOffsets.map((d, i) => isWeeklyMode ? `Sem ${i + 1}` : '+' + d + 'd');
            const palette = categoricalPalette(topCats.length);

            const datasets = topCats.map((cat, idx) => {
                const info = byCategory[cat];
                const daysCovered = Math.max(1, Math.round((today - info.oldest) / 86400000));
                const dailyAvg = info.total / daysCovered;
                const data = dayOffsets.map(d => dailyAvg * d);
                return { label: cat, data, backgroundColor: palette[idx], borderColor: palette[idx], fill: true, tension: 0.3, pointRadius: 0 };
            });

            const ctx = canvas.getContext('2d');
            if(forecastCategoryChartInstance) forecastCategoryChartInstance.destroy();
            forecastCategoryChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { stacked: true, grid: { color: cssVar('--border') } }, x: { grid: { display: false } } }, plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } } } }
            });
        }

        function updateForecastFreshness() {
            const el = document.getElementById('forecast-freshness-note');
            if(!el) return;
            if(!appDB.forecastLastViewed) appDB.forecastLastViewed = {};
            const todayStr = getTodayDate();
            const lastViewed = appDB.forecastLastViewed[appDB.currentCompanyId];
            if(lastViewed !== todayStr) {
                appDB.forecastLastViewed[appDB.currentCompanyId] = todayStr;
                saveToCloud();
            }
            const lastDate = parseBRDate(lastViewed || todayStr);
            const today = new Date(); today.setHours(0,0,0,0);
            const daysSince = lastDate ? Math.round((today - lastDate) / 86400000) : 0;
            if(!lastViewed || daysSince <= 0) el.textContent = 'projeção revisada hoje.';
            else if(daysSince <= 7) el.textContent = `projeção revisada há ${daysSince} dia${daysSince === 1 ? '' : 's'} — dentro da cadência semanal recomendada.`;
            else el.innerHTML = `<span style="color: var(--gold);">projeção não é revisada há ${daysSince} dias</span> — atualizações semanais tendem a manter a previsão bem mais precisa.`;
        }

        function resetForecastScenario() {
            document.getElementById('forecast-extra-cost').value = '';
            document.getElementById('forecast-revenue-change').value = '';
            updateForecasting();
        }

        function exportForecastChart() {
            if(!forecastChartInstance) { showToast("Gere uma projeção primeiro."); return; }
            const link = document.createElement('a');
            link.href = forecastChartInstance.toBase64Image();
            link.download = `luppus_projecao_${Date.now()}.png`;
            link.click();
        }

        // --- COFRE DIGITAL (VAULT) ---
        function parseBRDate(str) {
            if(!str) return null;
            const parts = str.trim().split('/');
            if(parts.length !== 3) return null;
            const day = Number(parts[0]), month = Number(parts[1]), year = Number(parts[2]);
            const d = new Date(year, month - 1, day);
            if(isNaN(d.getTime())) return null;
            // new Date() rola datas inexistentes (ex: 31/02) pro mês seguinte em vez de rejeitar —
            // conferimos se os componentes batem pra pegar esse caso.
            if(d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
            return d;
        }

        function vaultExpiryBadge(expiry) {
            const expDate = parseBRDate(expiry);
            if(!expDate) return '';
            const today = new Date(); today.setHours(0,0,0,0);
            const diffDays = Math.round((expDate - today) / 86400000);
            if(diffDays < 0) return `<span class="chip chip-danger">vencido em ${expiry}</span>`;
            if(diffDays <= 30) return `<span class="chip">vence em ${diffDays}d (${expiry})</span>`;
            return `<span class="chip chip-success">válido até ${expiry}</span>`;
        }

        // Política de retenção padrão por categoria — só entra em jogo quando o documento não tem
        // uma validade explícita definida pelo usuário (a validade sempre tem prioridade).
        const VAULT_RETENTION_YEARS = { 'Nota Fiscal': 5, 'Contrato': 5, 'Comprovante': 5, 'Certidão': 2, 'Outro': 2 };
        function vaultRetentionBadge(d) {
            if(d.expiry) return '';
            const years = VAULT_RETENTION_YEARS[d.category] || VAULT_RETENTION_YEARS['Outro'];
            const uploadDate = parseBRDate(d.date);
            if(!uploadDate) return '';
            const eligibleDate = new Date(uploadDate); eligibleDate.setFullYear(eligibleDate.getFullYear() + years);
            const today = new Date(); today.setHours(0, 0, 0, 0);
            if(today >= eligibleDate) return `<span class="chip chip-danger">elegível para descarte (retenção de ${years} anos vencida)</span>`;
            return '';
        }

        // Comprime imagens grandes (reduzindo qualidade e depois dimensões) até caberem no limite,
        // em vez de simplesmente rejeitar o arquivo. PDFs não têm como ser comprimidos no navegador.
        const MAX_FILE_BYTES = 512000;
        function fileToDataURLCompressed(file, maxBytes) {
            return new Promise((resolve, reject) => {
                if (!file.type.startsWith('image/') || file.size <= maxBytes) {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                    return;
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        // Fotos de celular costumam vir enormes (4000px+) — reduzir o tamanho
                        // logo de início evita travar o navegador comprimindo em resolução total.
                        const MAX_DIMENSION = 1600;
                        const baseScale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
                        let quality = 0.85, scale = 1, attempts = 0;
                        const MAX_ATTEMPTS = 8; // garante que sempre termina, mesmo com imagens que não comprimem bem
                        const tryCompress = () => {
                            attempts++;
                            const canvas = document.createElement('canvas');
                            canvas.width = Math.max(1, Math.round(img.width * baseScale * scale));
                            canvas.height = Math.max(1, Math.round(img.height * baseScale * scale));
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            const dataUrl = canvas.toDataURL('image/jpeg', quality);
                            const approxBytes = dataUrl.length * 0.75;
                            if (approxBytes <= maxBytes || attempts >= MAX_ATTEMPTS || (quality <= 0.35 && scale <= 0.35)) {
                                resolve(dataUrl);
                            } else if (quality > 0.35) {
                                quality -= 0.15;
                                setTimeout(tryCompress, 0);
                            } else {
                                scale -= 0.15;
                                setTimeout(tryCompress, 0);
                            }
                        };
                        tryCompress();
                    };
                    img.onerror = reject;
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        let vaultUploadInFlight = false;
        function processVaultUpload() {
            if(vaultUploadInFlight) return;
            const name = document.getElementById('vault-name').value.trim();
            const category = document.getElementById('vault-category').value;
            const expiry = document.getElementById('vault-expiry').value.trim();
            const fileInput = document.getElementById('vault-file');
            const file = fileInput.files[0];

            if(!name || !file) { showToast("Preencha nome e anexe documento."); return; }
            if(file.type === 'application/pdf' && file.size > MAX_FILE_BYTES) { showToast("PDF acima de 500KB — reduza o tamanho do arquivo antes de anexar."); return; }
            if(expiry && !parseBRDate(expiry)) { showToast("Data de validade inválida. Use DD/MM/AAAA."); return; }

            vaultUploadInFlight = true;
            const btn = document.getElementById('vault-submit-btn');
            const originalLabel = btn ? btn.innerText : '';
            if(btn) { btn.disabled = true; btn.innerText = 'processando...'; }

            fileToDataURLCompressed(file, MAX_FILE_BYTES).then(async (dataUrl) => {
                if(!appDB.vault) appDB.vault = {};
                if(!appDB.vault[appDB.currentCompanyId]) appDB.vault[appDB.currentCompanyId] = [];
                const docs = appDB.vault[appDB.currentCompanyId];

                const hash = await sha256Hex(dataUrl);
                const dupByContent = docs.find(d => d.hash === hash);
                if(dupByContent && !confirm(`Este arquivo parece idêntico a "${dupByContent.name}", já salvo no cofre. Enviar mesmo assim?`)) {
                    vaultUploadInFlight = false; if(btn) { btn.disabled = false; btn.innerText = originalLabel; }
                    return;
                }

                const existingIdx = docs.findIndex(d => d.name.toLowerCase() === name.toLowerCase());
                if(existingIdx !== -1) {
                    const existing = docs[existingIdx];
                    if(!existing.versions) existing.versions = [];
                    existing.versions.unshift({ data: existing.file.data, fname: existing.file.fname, mime: existing.file.mime, uploadedAt: existing.date });
                    if(existing.versions.length > 5) existing.versions.length = 5;
                    existing.file = { data: dataUrl, fname: file.name, mime: file.type };
                    existing.date = getTodayDate();
                    existing.category = category;
                    existing.expiry = expiry;
                    existing.hash = hash;
                    showToast(`Nova versão de "${name}" salva (${existing.versions.length} anterior${existing.versions.length === 1 ? '' : 'es'} preservada${existing.versions.length === 1 ? '' : 's'}).`);
                } else {
                    docs.push({ date: getTodayDate(), name: name, category: category, expiry: expiry, hash: hash, file: { data: dataUrl, fname: file.name, mime: file.type } });
                    showToast("Salvo no Cofre.");
                }

                logVaultAccess(name, 'upload');
                saveToCloud();
                document.getElementById('vault-name').value = '';
                document.getElementById('vault-expiry').value = '';
                fileInput.value = '';
                renderVault();
            }).catch(() => showToast("Não foi possível processar o arquivo."))
            .finally(() => { vaultUploadInFlight = false; if(btn) { btn.disabled = false; btn.innerText = originalLabel; } });
        }

        function logVaultAccess(docName, action) {
            if(!appDB.vaultAccessLog) appDB.vaultAccessLog = {};
            if(!appDB.vaultAccessLog[appDB.currentCompanyId]) appDB.vaultAccessLog[appDB.currentCompanyId] = [];
            const log = appDB.vaultAccessLog[appDB.currentCompanyId];
            log.push({ ts: new Date().toISOString(), user: getCurrentUserLabel(), action, docName });
            if(log.length > 200) log.shift();
        }

        function renderVault() {
            const ul = document.getElementById('vault-list');
            if(!ul) return;
            ul.innerHTML = '';
            const allDocs = (appDB.vault && appDB.vault[appDB.currentCompanyId]) ? appDB.vault[appDB.currentCompanyId] : [];

            if(allDocs.length === 0) {
                ul.innerHTML = '<li class="empty-state">Nenhum documento no cofre ainda.</li>';
                updatePainelAlerts();
                renderVaultChecklist(allDocs);
                renderVaultStorageNote(allDocs);
                renderVaultAccessLog();
                return;
            }

            const searchEl = document.getElementById('vault-search');
            const query = searchEl ? searchEl.value.trim().toLowerCase() : '';

            let matchCount = 0;
            allDocs.forEach((d, i) => {
                if(query && !d.name.toLowerCase().includes(query) && !(d.category || '').toLowerCase().includes(query)) return;
                matchCount++;

                const li = document.createElement('li');
                li.className = 'recent-item';
                let deleteBtnHtml = isClientMode ? '' : `<button class="icon-btn" onclick="deleteVault(${i})" aria-label="excluir documento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
                const categoryChip = d.category ? `<span class="chip">${escapeHtml(d.category)}</span>` : '';
                const expiryChip = vaultExpiryBadge(d.expiry);
                const retentionChip = vaultRetentionBadge(d);
                const versionsChip = (d.versions && d.versions.length > 0) ? `<span class="chip">${d.versions.length} versão${d.versions.length === 1 ? '' : 'ões'} anterior${d.versions.length === 1 ? '' : 'es'}</span>` : '';
                li.innerHTML = `
                    <div>
                        <strong style="color: var(--text-main);">${escapeHtml(d.name)}</strong> <span style="color:var(--text-muted); font-size:10px;">(${d.date})</span>
                        ${(categoryChip || expiryChip || retentionChip || versionsChip) ? `<div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${categoryChip}${expiryChip}${retentionChip}${versionsChip}</div>` : ''}
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                        <button class="icon-btn" onclick="openVaultPreview(${i})" aria-label="visualizar documento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                        <a href="${d.file.data}" download="${d.file.fname}" class="attachment-link" onclick="logVaultAccess('${escapeHtml(d.name)}', 'download'); saveToCloud(); renderVaultAccessLog();">Download</a>
                        ${deleteBtnHtml}
                    </div>
                `;
                ul.appendChild(li);
            });

            if(matchCount === 0) { ul.innerHTML = '<li class="empty-state">Nenhum documento encontrado.</li>'; }
            updatePainelAlerts();
            renderVaultChecklist(allDocs);
            renderVaultStorageNote(allDocs);
            renderVaultAccessLog();
        }

        const VAULT_REQUIRED_DOCS = ['CNPJ', 'Contrato Social', 'Alvará', 'Certidão Negativa'];
        function renderVaultChecklist(allDocs) {
            const body = document.getElementById('vault-checklist-body');
            if(!body) return;
            const names = allDocs.map(d => d.name.toLowerCase());
            const rows = VAULT_REQUIRED_DOCS.map(req => {
                const found = names.some(n => n.includes(req.toLowerCase()) || req.toLowerCase().includes(n));
                const icon = found
                    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`
                    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle></svg>`;
                return `<div class="outlier-row"><span style="display:flex; align-items:center; gap:10px;">${icon} ${escapeHtml(req)}</span><span style="color:var(--text-muted); font-size:11px;">${found ? 'encontrado' : 'faltando'}</span></div>`;
            }).join('');
            const completeCount = VAULT_REQUIRED_DOCS.filter(req => names.some(n => n.includes(req.toLowerCase()) || req.toLowerCase().includes(n))).length;
            body.innerHTML = `<p class="support-note" style="margin-top:0;">${completeCount} de ${VAULT_REQUIRED_DOCS.length} documentos de referência encontrados.</p>` + rows;
        }

        function renderVaultStorageNote(allDocs) {
            const el = document.getElementById('vault-storage-note');
            if(!el) return;
            const totalChars = allDocs.reduce((sum, d) => {
                let size = (d.file && d.file.data) ? d.file.data.length : 0;
                if(d.versions) size += d.versions.reduce((s, v) => s + (v.data ? v.data.length : 0), 0);
                return sum + size;
            }, 0);
            const approxBytes = totalChars * 0.75; // base64 ~ 4/3 do tamanho binário real
            const kb = approxBytes / 1024;
            const softLimitKb = 700; // margem de segurança abaixo do limite de 1 MiB por documento do Firestore
            const pct = Math.min(100, (kb / softLimitKb) * 100);
            const sizeLabel = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
            const color = pct > 80 ? 'var(--danger)' : (pct > 50 ? 'var(--gold)' : 'var(--text-muted)');
            el.innerHTML = `<span style="color:${color};">cofre usando ~${sizeLabel}</span> de um limite prático de ~700 KB neste registro na nuvem (o restante é dividido com lançamentos e planilhas).`;
        }

        function renderVaultAccessLog() {
            const card = document.getElementById('vault-accesslog-card');
            const body = document.getElementById('vault-accesslog-body');
            if(!card || !body) return;
            if(isClientMode) { card.style.display = 'none'; return; }
            card.style.display = 'block';
            const log = (appDB.vaultAccessLog && appDB.vaultAccessLog[appDB.currentCompanyId]) || [];
            if(log.length === 0) { body.innerHTML = '<p class="support-note" style="margin:0;">Nenhum acesso registrado ainda.</p>'; return; }
            const actionLabels = { view: 'visualizou', download: 'baixou', upload: 'enviou' };
            body.innerHTML = log.slice().reverse().slice(0, 15).map(entry => {
                const when = new Date(entry.ts);
                const whenLabel = isNaN(when.getTime()) ? entry.ts : when.toLocaleString('pt-BR');
                return `<div class="aging-row"><span>${escapeHtml(entry.user)} ${actionLabels[entry.action] || entry.action} <strong>${escapeHtml(entry.docName)}</strong></span><span style="color:var(--text-muted); font-size:10px;">${whenLabel}</span></div>`;
            }).join('');
        }

        async function downloadVaultZip() {
            const allDocs = (appDB.vault && appDB.vault[appDB.currentCompanyId]) ? appDB.vault[appDB.currentCompanyId] : [];
            if(allDocs.length === 0) { showToast('Nenhum documento no cofre para baixar.'); return; }
            if(typeof JSZip === 'undefined') { showToast('Biblioteca de compactação ainda carregando, tente novamente em instantes.'); return; }
            showToast('Preparando arquivo .zip...');
            const zip = new JSZip();
            const manifest = [];
            allDocs.forEach((d, i) => {
                const dataUrl = d.file.data;
                const commaIdx = dataUrl.indexOf(',');
                const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
                const safeName = `${i + 1}_${d.file.fname}`.replace(/[\\/:*?"<>|]/g, '_');
                zip.file(safeName, base64, { base64: true });
                manifest.push({ arquivo: safeName, nome: d.name, categoria: d.category || '', data: d.date, validade: d.expiry || '' });
                logVaultAccess(d.name, 'download');
            });
            zip.file('manifest.json', JSON.stringify(manifest, null, 2));
            saveToCloud();
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `LUPPUS_cofre_${Date.now()}.zip`;
            link.click();
            URL.revokeObjectURL(url);
            showToast('Download do .zip iniciado.');
        }

        function openFilePreview(title, fileObj) {
            document.getElementById('vault-preview-title').textContent = title;
            const body = document.getElementById('vault-preview-body');
            const mime = (fileObj.mime || '').toLowerCase();
            const fname = (fileObj.fname || '').toLowerCase();
            const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(fname);
            const isPdf = mime === 'application/pdf' || fname.endsWith('.pdf');
            if(isImage) {
                body.innerHTML = `<img src="${fileObj.data}" alt="${escapeHtml(title)}">`;
            } else if(isPdf) {
                body.innerHTML = `<iframe src="${fileObj.data}" title="${escapeHtml(title)}"></iframe>`;
            } else {
                body.innerHTML = `<p class="empty-state">Pré-visualização não disponível para este tipo de arquivo. Use o download.</p>`;
            }
            document.getElementById('vault-preview-overlay').style.display = 'flex';
        }

        function openVaultPreview(index) {
            const docs = appDB.vault[appDB.currentCompanyId];
            const d = docs[index];
            if(!d) return;
            logVaultAccess(d.name, 'view');
            saveToCloud();
            renderVaultAccessLog();
            openFilePreview(d.name, { data: d.file.data, mime: d.file.mime, fname: d.file.fname });
        }

        function closeVaultPreview() {
            document.getElementById('vault-preview-overlay').style.display = 'none';
            document.getElementById('vault-preview-body').innerHTML = '';
        }

        function deleteVault(index) {
            if(confirm("Excluir documento do cofre?")) {
                const removed = appDB.vault[appDB.currentCompanyId][index];
                appDB.vault[appDB.currentCompanyId].splice(index, 1);
                logAudit('vault', 'delete', removed ? removed.name : '(desconhecido)', removed ? removed.name : null, null);
                saveToCloud();
                renderVault();
            }
        }

        // --- TRANSACTIONS & OFX ---
        function getTodayDate() {
            const today = new Date(); const dd = String(today.getDate()).padStart(2, '0'); const mm = String(today.getMonth() + 1).padStart(2, '0');
            return `${dd}/${mm}/${today.getFullYear()}`;
        }

        let editingTransactionIndex = null;
        let pendingReceiptPreviewData = null;

        function handleReceiptFileChange() {
            const file = document.getElementById('receipt').files[0];
            const btn = document.getElementById('receipt-preview-btn');
            pendingReceiptPreviewData = null;
            if(!file) { btn.style.display = 'none'; return; }
            const reader = new FileReader();
            reader.onload = function(e) {
                pendingReceiptPreviewData = { data: e.target.result, mime: file.type, fname: file.name };
                btn.style.display = 'inline-block';
            };
            reader.readAsDataURL(file);
        }

        function previewReceiptFile() {
            if(!pendingReceiptPreviewData) return;
            openFilePreview('Comprovante', pendingReceiptPreviewData);
        }

        function generateRecurringOccurrences(startDateStr, desc, type, amount, category) {
            const startDate = parseBRDate(startDateStr);
            if(!startDate) return;
            const txArray = appDB.transactions[appDB.currentCompanyId];
            for(let i = 1; i <= 11; i++) {
                const d = new Date(startDate);
                d.setMonth(d.getMonth() + i);
                const dateStr = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
                txArray.push({ date: dateStr, desc: desc + ' (recorrente)', type, amount, category, recurring: true, receipt: null });
            }
        }

        let transactionSubmitInFlight = false;
        function processTransaction() {
            if(transactionSubmitInFlight) return;
            let dateVal = document.getElementById('entry-date').value.trim(); if(!dateVal) dateVal = getTodayDate();
            const desc = document.getElementById('desc').value.trim();
            const type = document.getElementById('type').value;
            const amount = parseFloat(document.getElementById('amount').value);
            const category = document.getElementById('entry-category').value;
            const recurring = document.getElementById('entry-recurring').checked;
            const file = document.getElementById('receipt').files[0];

            if (!desc || isNaN(amount) || amount <= 0) { showToast("Preencha descrição e valor."); return; }
            if (!parseBRDate(dateVal)) { showToast("Data inválida. Use DD/MM/AAAA."); return; }
            if (file && file.type === 'application/pdf' && file.size > MAX_FILE_BYTES) { showToast("PDF acima de 500KB — reduza o tamanho do arquivo antes de anexar."); return; }

            const existingTx = appDB.transactions[appDB.currentCompanyId] || [];
            const isDuplicate = existingTx.some((t, i) => {
                if(editingTransactionIndex !== null && i === editingTransactionIndex) return false;
                return t.date === dateVal && t.amount === amount && t.desc.trim().toLowerCase() === desc.toLowerCase();
            });
            if(isDuplicate && !confirm("Já existe um lançamento com a mesma data, valor e descrição. Lançar mesmo assim?")) return;

            const approvalThreshold = parseFloat((appDB.approvalThreshold && appDB.approvalThreshold[appDB.currentCompanyId]) || '');
            const isHighValue = !isNaN(approvalThreshold) && amount >= approvalThreshold;
            if(isHighValue && !confirm(`Este lançamento (R$ ${amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}) está acima do limite de aprovação definido (R$ ${approvalThreshold.toLocaleString('pt-BR', {minimumFractionDigits: 2})}). Confirma o valor antes de lançar?`)) return;

            const finish = (receiptObj) => {
                if (!appDB.transactions[appDB.currentCompanyId]) appDB.transactions[appDB.currentCompanyId] = [];
                const txArray = appDB.transactions[appDB.currentCompanyId];
                const wasEditing = editingTransactionIndex !== null;

                const notifyPrefs = (appDB.notificationPrefs && appDB.notificationPrefs[appDB.currentCompanyId]) || {};
                const highValueSuffix = (isHighValue && notifyPrefs.highValueEntry) ? ` ⚠ valor acima do limite de aprovação.` : '';

                if(wasEditing) {
                    const existing = txArray[editingTransactionIndex];
                    const updated = { date: dateVal, desc, type, amount, category, recurring: existing.recurring, receipt: receiptObj || existing.receipt };
                    txArray[editingTransactionIndex] = updated;
                    logAudit('transaction', 'edit', desc, existing, updated);
                    showToast((receiptObj || existing.receipt ? "Lançamento atualizado." : "Lançamento atualizado — ainda pendente.") + highValueSuffix);
                } else {
                    const created = { date: dateVal, desc, type, amount, category, recurring: recurring || false, receipt: receiptObj || null };
                    txArray.push(created);
                    logAudit('transaction', 'create', desc, null, created);
                    showToast((receiptObj ? "Lançamento registrado." : "Lançamento registrado como pendente — anexe o comprovante depois.") + highValueSuffix);
                    if(recurring) generateRecurringOccurrences(dateVal, desc, type, amount, category);
                }

                saveToCloud();
                applySmartSearch();
                cancelEditTransaction();

                if(pendingOFX.length > 0) { loadOFX(0); showToast('Próximo item do extrato carregado.'); }
            };

            if(file) {
                transactionSubmitInFlight = true;
                const btn = document.getElementById('entry-submit-btn');
                const originalLabel = btn ? btn.innerText : '';
                if(btn) { btn.disabled = true; btn.innerText = 'processando...'; }

                fileToDataURLCompressed(file, MAX_FILE_BYTES)
                    .then((dataUrl) => { finish({ data: dataUrl, name: file.name }); })
                    .catch(() => { showToast("Não foi possível processar o arquivo."); if(btn) btn.innerText = originalLabel; })
                    .finally(() => { transactionSubmitInFlight = false; if(btn) btn.disabled = false; });
            } else {
                finish(null);
            }
        }

        function editTransaction(index) {
            const t = appDB.transactions[appDB.currentCompanyId][index];
            if(!t) return;
            document.getElementById('entry-date').value = t.date;
            document.getElementById('desc').value = t.desc;
            document.getElementById('type').value = t.type;
            document.getElementById('amount').value = t.amount;
            document.getElementById('entry-category').value = t.category || '';
            document.getElementById('receipt').value = '';
            pendingReceiptPreviewData = null;
            document.getElementById('receipt-preview-btn').style.display = 'none';
            editingTransactionIndex = index;
            document.getElementById('entry-form-title').textContent = 'editar lançamento';
            document.getElementById('entry-submit-btn').textContent = 'salvar alterações';
            document.getElementById('entry-cancel-btn').style.display = 'block';
            const noteEl = document.getElementById('receipt-current-note');
            noteEl.textContent = t.receipt ? `comprovante atual: ${t.receipt.name} — deixe o campo em branco para manter.` : 'sem comprovante — este lançamento está pendente e não entra nos totais.';
            noteEl.style.display = 'block';
            switchView('lancamentos');
        }

        function cancelEditTransaction() {
            editingTransactionIndex = null;
            document.getElementById('entry-date').value = getTodayDate();
            document.getElementById('desc').value = '';
            document.getElementById('amount').value = '';
            document.getElementById('entry-category').value = '';
            document.getElementById('entry-recurring').checked = false;
            document.getElementById('receipt').value = '';
            pendingReceiptPreviewData = null;
            document.getElementById('receipt-preview-btn').style.display = 'none';
            document.getElementById('entry-form-title').textContent = 'registro manual';
            document.getElementById('entry-submit-btn').textContent = 'lançar no sistema';
            document.getElementById('entry-cancel-btn').style.display = 'none';
            document.getElementById('receipt-current-note').style.display = 'none';
        }

        function deleteTransaction(index) {
            if(confirm("Excluir lançamento?")) {
                const removed = appDB.transactions[appDB.currentCompanyId][index];
                appDB.transactions[appDB.currentCompanyId].splice(index, 1);
                logAudit('transaction', 'delete', removed ? removed.desc : '(desconhecido)', removed, null);
                bulkSelectedIndices.delete(index);
                saveToCloud();
                applySmartSearch();
            }
        }

        // --- SELEÇÃO E EDIÇÃO EM MASSA ---
        let bulkSelectedIndices = new Set();

        function toggleBulkRow(index, checked) {
            if(checked) bulkSelectedIndices.add(index); else bulkSelectedIndices.delete(index);
            updateBulkActionsBar();
        }

        function toggleBulkSelectAll(checked) {
            document.querySelectorAll('#history-table tbody .bulk-row-checkbox').forEach(cb => {
                cb.checked = checked;
                cb.dispatchEvent(new Event('change'));
            });
        }

        function clearBulkSelection() {
            bulkSelectedIndices.clear();
            document.querySelectorAll('#history-table tbody .bulk-row-checkbox').forEach(cb => cb.checked = false);
            const selectAll = document.getElementById('bulk-select-all');
            if(selectAll) selectAll.checked = false;
            updateBulkActionsBar();
        }

        function updateBulkActionsBar() {
            const bar = document.getElementById('bulk-actions-bar');
            const countEl = document.getElementById('bulk-selected-count');
            if(!bar) return;
            if(bulkSelectedIndices.size === 0) { bar.style.display = 'none'; return; }
            bar.style.display = 'flex';
            countEl.textContent = `${bulkSelectedIndices.size} selecionado${bulkSelectedIndices.size === 1 ? '' : 's'}`;
            const select = document.getElementById('bulk-category-select');
            if(select) {
                const currentValue = select.value;
                select.innerHTML = getCategories().map(c => `<option${c === currentValue ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
            }
        }

        function applyBulkCategory() {
            const select = document.getElementById('bulk-category-select');
            const category = select ? select.value : '';
            if(!category || bulkSelectedIndices.size === 0) return;
            const txArray = appDB.transactions[appDB.currentCompanyId] || [];
            let count = 0;
            bulkSelectedIndices.forEach(idx => {
                const t = txArray[idx];
                if(!t) return;
                const before = { ...t };
                t.category = category;
                logAudit('transaction', 'edit', t.desc, before, t);
                count++;
            });
            saveToCloud();
            clearBulkSelection();
            applySmartSearch();
            showToast(`Categoria aplicada a ${count} lançamento${count === 1 ? '' : 's'}.`);
        }

        function deleteBulkSelected() {
            if(bulkSelectedIndices.size === 0) return;
            if(!confirm(`Excluir ${bulkSelectedIndices.size} lançamento(s) selecionado(s)? Essa ação não pode ser desfeita.`)) return;
            const txArray = appDB.transactions[appDB.currentCompanyId] || [];
            const sortedIndices = Array.from(bulkSelectedIndices).sort((a, b) => b - a);
            sortedIndices.forEach(idx => {
                const removed = txArray[idx];
                if(!removed) return;
                txArray.splice(idx, 1);
                logAudit('transaction', 'delete', removed.desc, removed, null);
            });
            const count = sortedIndices.length;
            clearBulkSelection();
            saveToCloud();
            applySmartSearch();
            showToast(`${count} lançamento${count === 1 ? '' : 's'} excluído${count === 1 ? '' : 's'}.`);
        }

        function handleOFX() {
            const fileInput = document.getElementById('ofx-file');
            if(!fileInput.files[0]) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                pendingOFX = []; const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi; let match;
                while ((match = trnRegex.exec(e.target.result)) !== null) {
                    const block = match[1]; let dateMatch = block.match(/<DTPOSTED>(\d{8})/); let fDate = getTodayDate();
                    if(dateMatch) { let d = dateMatch[1]; fDate = `${d.substring(6,8)}/${d.substring(4,6)}/${d.substring(0,4)}`; }
                    let amtMatch = block.match(/<TRNAMT>([-\d\.]+)/); let amount = amtMatch ? parseFloat(amtMatch[1]) : 0;
                    if(amount === 0) continue; 
                    let memo = block.match(/<MEMO>(.*)/); let name = block.match(/<NAME>(.*)/);
                    let desc = memo ? memo[1].trim() : (name ? name[1].trim() : "Bancário");
                    pendingOFX.push({ date: fDate, desc: desc.replace(/<.*$/, ''), amount: Math.abs(amount), type: amount >= 0 ? "in" : "out" });
                }
                fileInput.value = '';
                if(pendingOFX.length>0) {
                    const ul = document.getElementById('ofx-items'); ul.innerHTML = '';
                    document.getElementById('ofx-queue-container').style.display = 'block';
                    pendingOFX.forEach((t, i) => {
                        const li = document.createElement('li'); li.className = 'ofx-item ' + (t.type==='in'?'ofx-item-in':'ofx-item-out');
                        li.innerHTML = `<div><strong style="color:var(--text-main);">${t.date}</strong> | <span style="color:var(--text-muted);">${escapeHtml(t.desc.substring(0,25))}</span><br><span style="color:${t.type==='in'?'var(--success)':'var(--danger)'};">R$ ${t.amount.toFixed(2)}</span></div><button class="outline-btn" style="padding:6px;" onclick="loadOFX(${i})">Validar</button>`;
                        ul.appendChild(li);
                    });
                } else { showToast("Sem lançamentos no OFX."); }
            };
            reader.readAsText(fileInput.files[0]);
        }
        function loadOFX(index) {
            const t = pendingOFX[index]; document.getElementById('entry-date').value = t.date; document.getElementById('desc').value = t.desc; document.getElementById('amount').value = t.amount.toFixed(2); document.getElementById('type').value = t.type;
            pendingOFX.splice(index, 1); document.getElementById('ofx-items').children[index].remove();
            if(pendingOFX.length === 0) document.getElementById('ofx-queue-container').style.display = 'none';
        }

        // --- MÓDULOS BI E PLANILHAS ---
        const DEFAULT_SHEET_DATA = [['Item', 'Qtd', 'Status'],['', '', ''],['', '', '']];
        const SHEET_TEMPLATES = {
            estoque: [['Item', 'Quantidade', 'Valor Unitário', 'Estoque Mínimo', 'Status'],['', '', '', '', '']],
            pagamentos: [['Fornecedor', 'Vencimento', 'Valor', 'Pago?'],['', '', '', '']],
            recebimentos: [['Cliente', 'Vencimento', 'Valor', 'Recebido?'],['', '', '', '']],
            fornecedores: [['Fornecedor', 'Contato', 'Categoria', 'Aprovado?'],['', '', '', '']],
            contratos: [['Contrato', 'Cliente/Fornecedor', 'Vigência até', 'Status'],['', '', '', '']],
            planoContas: [['Código', 'Conta', 'Categoria', 'Tipo'],['', '', '', '']],
            reembolsos: [['Colaborador', 'Data', 'Categoria', 'Valor', 'Aprovado?'],['', '', '', '', '']],
            compliance: [['Documento', 'Responsável', 'Prazo', 'Concluído?'],['', '', '', '']],
            ativos: [['Ativo', 'Categoria', 'Data de Aquisição', 'Valor', 'Status'],['', '', '', '', '']],
            onboarding: [['Cliente', 'Etapa', 'Responsável', 'Concluído?'],['', '', '', '']],
            processo: [['Etapa', 'Responsável', 'Tempo de Execução (min)', 'Tempo de Espera (min)', 'Observações'],['', '', '', '', '']]
        };

        function getSheets() {
            if(!appDB.spreadsheets) appDB.spreadsheets = {};
            let sheets = appDB.spreadsheets[appDB.currentCompanyId];
            if(Array.isArray(sheets) && sheets.length > 0 && Array.isArray(sheets[0])) {
                sheets = [{ id: 'sheet-' + Date.now(), name: 'Planilha 1', data: sheets, savedAt: null }];
            }
            if(!sheets || sheets.length === 0) {
                sheets = [{ id: 'sheet-' + Date.now(), name: 'Planilha 1', data: DEFAULT_SHEET_DATA.map(r => r.slice()), savedAt: null }];
            }
            appDB.spreadsheets[appDB.currentCompanyId] = sheets;
            return sheets;
        }

        function getActiveSheetId() {
            if(!appDB.spreadsheetActiveId) appDB.spreadsheetActiveId = {};
            const sheets = getSheets();
            let id = appDB.spreadsheetActiveId[appDB.currentCompanyId];
            if(!id || !sheets.find(s => s.id === id)) id = sheets[0].id;
            appDB.spreadsheetActiveId[appDB.currentCompanyId] = id;
            return id;
        }

        function getActiveSheet() {
            const sheets = getSheets();
            const id = getActiveSheetId();
            return sheets.find(s => s.id === id) || sheets[0];
        }

        function saveActiveSheetDataLocally() {
            if(!mySpreadsheet) return;
            getActiveSheet().data = mySpreadsheet.getData().map(row => row.slice());
        }

        function initSpreadsheet() {
            const container = document.getElementById('spreadsheet-area');
            if(!container || typeof jspreadsheet === 'undefined') return;
            container.innerHTML = '';
            const sheet = getActiveSheet();
            const data = (sheet.data && sheet.data.length > 0) ? sheet.data : DEFAULT_SHEET_DATA.map(r => r.slice());
            mySpreadsheet = jspreadsheet(container, { data: data, minDimensions: [6, 10], defaultColWidth: 120, tableOverflow: true, tableHeight: '350px', tableWidth: '100%' });
            renderSheetTabs();
            renderSheetMeta();
        }

        function renderSheetTabs() {
            const sheets = getSheets();
            const activeId = getActiveSheetId();
            const container = document.getElementById('sheet-tabs');
            if(!container) return;
            const tabsHtml = sheets.map(s => `<button type="button" class="sheet-tab ${s.id === activeId ? 'active' : ''}" onclick="switchSheet('${s.id}')">${escapeHtml(s.name)}</button>`).join('');
            const addHtml = isClientMode ? '' : `<button type="button" class="sheet-tab-add" onclick="addSheet()" aria-label="nova planilha">+</button>`;
            container.innerHTML = tabsHtml + addHtml;
        }

        function renderSheetMeta() {
            const el = document.getElementById('sheet-meta');
            if(!el) return;
            const sheet = getActiveSheet();
            const byWhom = sheet.savedBy ? ` por ${sheet.savedBy}` : '';
            el.textContent = sheet.name + (sheet.savedAt ? ` · salvo em ${sheet.savedAt}${byWhom}` : ' · ainda não salvo');
            renderSheetHistory();
            renderSheetABCXYZ();
        }

        function renderSheetHistory() {
            const container = document.getElementById('sheet-history');
            const listEl = document.getElementById('sheet-history-list');
            if(!container || !listEl) return;
            const sheet = getActiveSheet();
            const history = spreadsheetHistory[sheet.id] || [];
            if(history.length === 0) { container.style.display = 'none'; return; }
            container.style.display = 'block';
            listEl.innerHTML = history.slice().reverse().map((snap, revIdx) => {
                const idx = history.length - 1 - revIdx;
                return `<div class="variance-row"><span>${escapeHtml(snap.savedAt)}${snap.savedBy ? ' · ' + escapeHtml(snap.savedBy) : ''}</span><button type="button" class="outline-btn" style="padding:4px 10px; font-size:10px;" onclick="restoreSheetVersion(${idx})">restaurar</button></div>`;
            }).join('');
        }

        function restoreSheetVersion(idx) {
            const sheet = getActiveSheet();
            const history = spreadsheetHistory[sheet.id] || [];
            const snap = history[idx];
            if(!snap) return;
            if(!confirm(`Restaurar a versão salva em ${snap.savedAt}? A versão atual não salva será perdida.`)) return;
            sheet.data = snap.data.map(row => row.slice());
            initSpreadsheet();
            saveToCloud();
            showToast('Versão restaurada.');
        }

        function switchSheet(id) {
            saveActiveSheetDataLocally();
            appDB.spreadsheetActiveId[appDB.currentCompanyId] = id;
            initSpreadsheet();
        }

        function addSheet() {
            saveActiveSheetDataLocally();
            const name = prompt('Nome da nova planilha:', 'Nova Planilha');
            if(!name) return;
            const sheets = getSheets();
            const newSheet = { id: 'sheet-' + Date.now(), name: name.trim() || 'Nova Planilha', data: DEFAULT_SHEET_DATA.map(r => r.slice()), savedAt: null };
            sheets.push(newSheet);
            appDB.spreadsheetActiveId[appDB.currentCompanyId] = newSheet.id;
            initSpreadsheet();
            saveToCloud();
        }

        function renameSheet() {
            const sheet = getActiveSheet();
            const name = prompt('Renomear planilha:', sheet.name);
            if(!name) return;
            sheet.name = name.trim() || sheet.name;
            renderSheetTabs();
            renderSheetMeta();
            saveToCloud();
        }

        function deleteSheet() {
            const sheets = getSheets();
            if(sheets.length <= 1) { showToast('Precisa ter ao menos uma planilha.'); return; }
            if(!confirm('Excluir esta planilha? Essa ação não pode ser desfeita.')) return;
            const activeId = getActiveSheetId();
            const idx = sheets.findIndex(s => s.id === activeId);
            sheets.splice(idx, 1);
            appDB.spreadsheetActiveId[appDB.currentCompanyId] = sheets[0].id;
            initSpreadsheet();
            saveToCloud();
        }

        function applySheetTemplate(key) {
            const tpl = SHEET_TEMPLATES[key];
            if(!tpl) return;
            if(!confirm('Isso vai substituir o conteúdo da planilha ativa pelo modelo. Continuar?')) return;
            const sheet = getActiveSheet();
            const data = tpl.map(r => r.slice());
            for(let i = 0; i < 8; i++) data.push(new Array(tpl[0].length).fill(''));
            sheet.data = data;
            sheet.templateKey = key;
            initSpreadsheet();
            showToast('Modelo aplicado.');
        }

        function insertTotalRow() {
            if(!mySpreadsheet) return;
            const data = mySpreadsheet.getData();
            if(data.length === 0) return;
            const colCount = data[0].length;
            const totalRow = new Array(colCount).fill('');
            totalRow[0] = 'Total';
            for(let col = 1; col < colCount; col++) {
                let sum = 0; let hasNumber = false;
                for(let row = 1; row < data.length; row++) {
                    const raw = (data[row][col] || '').toString().trim();
                    if(raw === '' || raw.toLowerCase() === 'total') continue;
                    const num = parseFloat(raw.replace(/R\$/g,'').replace(/\./g,'').replace(/,/g,'.'));
                    if(!isNaN(num)) { sum += num; hasNumber = true; }
                }
                totalRow[col] = hasNumber ? sum : '';
            }
            data.push(totalRow);
            getActiveSheet().data = data;
            initSpreadsheet();
            showToast('Linha de total inserida.');
        }

        function undoSpreadsheet() {
            const sheet = getActiveSheet();
            const prev = spreadsheetUndoStash[sheet.id];
            if(!prev) { showToast('Nada para desfazer nesta planilha.'); return; }
            sheet.data = prev;
            delete spreadsheetUndoStash[sheet.id];
            initSpreadsheet();
            saveToCloud();
            showToast('Alteração desfeita.');
        }

        function saveSpreadsheet() {
            if(!mySpreadsheet) return;
            const sheet = getActiveSheet();
            spreadsheetUndoStash[sheet.id] = sheet.data.map(row => row.slice());

            if(sheet.savedAt) {
                if(!spreadsheetHistory[sheet.id]) spreadsheetHistory[sheet.id] = [];
                spreadsheetHistory[sheet.id].push({ data: sheet.data.map(row => row.slice()), savedAt: sheet.savedAt, savedBy: sheet.savedBy || null });
                if(spreadsheetHistory[sheet.id].length > 5) spreadsheetHistory[sheet.id].shift();
            }

            sheet.data = mySpreadsheet.getData().map(row => row.slice());
            sheet.savedAt = getTodayDate() + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            sheet.savedBy = getCurrentUserLabel();
            saveToCloud();
            renderSheetMeta();
            showToast('Planilha salva.');
        }

        function exportSpreadsheet() { if(mySpreadsheet) mySpreadsheet.download(); }

        function exportSheetAsChecklistPDF() {
            if(!mySpreadsheet) { showToast('Nada para exportar.'); return; }
            const data = mySpreadsheet.getData();
            if(!data || data.length < 2) { showToast('Planilha vazia.'); return; }
            const sheet = getActiveSheet();
            const headers = data[0];
            const rows = data.slice(1).filter(row => row.some(c => (c || '').toString().trim() !== ''));
            if(rows.length === 0) { showToast('Nenhuma linha preenchida para exportar.'); return; }

            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const marginX = 15; let y = 20;
            pdf.setFontSize(16); pdf.text(String(sheet.name), marginX, y); y += 8;
            pdf.setFontSize(9); pdf.setTextColor(120); pdf.text(`LUPPUS - gerado em ${getTodayDate()}`, marginX, y); y += 10;
            pdf.setTextColor(20);

            rows.forEach((row) => {
                if(y > 275) { pdf.addPage(); y = 20; }
                pdf.setFontSize(11);
                pdf.rect(marginX, y - 4, 4, 4);
                const lineText = headers.map((h, idx) => `${h}: ${row[idx] || '-'}`).join('  |  ');
                const wrapped = pdf.splitTextToSize(lineText, 170);
                pdf.text(wrapped, marginX + 8, y);
                y += (wrapped.length * 5) + 4;
            });

            pdf.save(`LUPPUS_checklist_${String(sheet.name).replace(/\s+/g, '_')}_${Date.now()}.pdf`);
            showToast('Checklist exportado.');
        }

        function importPendingTransactionsToSheet() {
            if(!mySpreadsheet) return;
            const pending = (appDB.transactions[appDB.currentCompanyId] || []).filter(t => !t.receipt);
            if(pending.length === 0) { showToast('Nenhum lançamento pendente para importar.'); return; }
            const data = mySpreadsheet.getData();
            const colCount = (data[0] && data[0].length) || 4;
            pending.forEach(t => {
                const row = new Array(colCount).fill('');
                row[0] = t.desc;
                if(colCount > 1) row[1] = t.date;
                if(colCount > 2) row[2] = t.amount.toFixed(2).replace('.', ',');
                if(colCount > 3) row[3] = 'Não';
                data.push(row);
            });
            getActiveSheet().data = data;
            initSpreadsheet();
            showToast(`${pending.length} pendência(s) importada(s).`);
        }

        function renderSheetABCXYZ() {
            const card = document.getElementById('sheet-abcxyz-card');
            const body = document.getElementById('sheet-abcxyz-body');
            if(!card || !body) return;
            const sheet = getActiveSheet();
            if(sheet.templateKey !== 'estoque') { card.style.display = 'none'; return; }
            const data = mySpreadsheet ? mySpreadsheet.getData() : sheet.data;
            if(!data || data.length < 2) { card.style.display = 'none'; return; }

            const parseNum = (v) => { const n = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
            const items = data.slice(1)
                .map(row => ({ name: row[0], qty: parseNum(row[1]), unitValue: parseNum(row[2]), minStock: parseNum(row[3]) }))
                .filter(it => it.name && it.name.toString().trim() !== '');

            if(items.length === 0) { card.style.display = 'none'; return; }
            card.style.display = 'block';

            items.forEach(it => { it.value = it.qty * it.unitValue; });
            const totalValue = items.reduce((a, b) => a + b.value, 0);
            items.sort((a, b) => b.value - a.value);
            let cum = 0;
            items.forEach(it => {
                cum += it.value;
                const cumPct = totalValue > 0 ? (cum / totalValue) * 100 : 0;
                it.abc = cumPct <= 80 ? 'A' : (cumPct <= 95 ? 'B' : 'C');
                it.reorderPoint = it.minStock * 1.2;
            });

            body.innerHTML = items.map(it => {
                const abcColor = it.abc === 'A' ? 'var(--danger)' : (it.abc === 'B' ? 'var(--gold)' : 'var(--text-muted)');
                return `<div class="outlier-row"><span>${escapeHtml(String(it.name))} <span class="chip" style="background:${abcColor}; color:var(--obsidian); padding:2px 8px; font-size:9px;">${it.abc}</span></span><span style="color:var(--text-muted); font-size:11px;">valor: R$ ${it.value.toLocaleString('pt-BR', {minimumFractionDigits: 2})} · reposição sugerida: ${it.reorderPoint.toLocaleString('pt-BR')}</span></div>`;
            }).join('');
        }
        
        // Faz split respeitando campos entre aspas (que podem conter o próprio separador,
        // ex: "Fornecedor, Ltda") — um split ingênuo quebraria essas colunas.
        function parseCsvLine(line, sep) {
            const cols = []; let cur = ''; let inQuotes = false;
            for(let i = 0; i < line.length; i++) {
                const ch = line[i];
                if(inQuotes) {
                    if(ch === '"') {
                        if(line[i+1] === '"') { cur += '"'; i++; }
                        else inQuotes = false;
                    } else cur += ch;
                } else {
                    if(ch === '"') inQuotes = true;
                    else if(ch === sep) { cols.push(cur.trim()); cur = ''; }
                    else cur += ch;
                }
            }
            cols.push(cur.trim());
            return cols;
        }

        function handleCSVUpload() {
            const file = document.getElementById('bi-csv').files[0]; if(!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                const lines = e.target.result.split(/\r?\n/).filter(l => l.trim() !== '');
                if(lines.length < 2) return;
                const sep = lines[0].includes(';') ? ';' : ','; biHeaders = parseCsvLine(lines[0], sep);
                biData = [];
                for(let i=1; i<lines.length; i++){
                    const cols = parseCsvLine(lines[i], sep); let rowObj = {};
                    biHeaders.forEach((h, idx) => { rowObj[h] = cols[idx]; }); biData.push(rowObj);
                }
                finalizeBIData();
            }; reader.readAsText(file);
        }

        function loadSystemDataToBI() {
            const txs = (appDB.transactions && appDB.transactions[appDB.currentCompanyId]) ? appDB.transactions[appDB.currentCompanyId] : [];
            if(txs.length === 0) { showToast("Nenhum lançamento no sistema ainda."); return; }
            biHeaders = ['Data', 'Descrição', 'Natureza', 'Valor'];
            biData = txs.map(t => ({ 'Data': t.date, 'Descrição': t.desc, 'Natureza': t.type === 'in' ? 'Receita' : 'Custo', 'Valor': t.amount }));
            document.getElementById('bi-csv').value = '';
            finalizeBIData();
            const sY = document.getElementById('bi-y'); if(sY) sY.value = 'Valor';
            const sX = document.getElementById('bi-x'); if(sX) sX.value = 'Natureza';
            updateBIChart();
        }

        function finalizeBIData() {
            const sX = document.getElementById('bi-x'); const sY = document.getElementById('bi-y'); const sFilterCol = document.getElementById('bi-filter-col');
            sX.innerHTML = ''; sY.innerHTML = ''; sFilterCol.innerHTML = '<option value="">nenhum</option>';
            biHeaders.forEach(h => { sX.innerHTML += `<option>${escapeHtml(h)}</option>`; sY.innerHTML += `<option>${escapeHtml(h)}</option>`; sFilterCol.innerHTML += `<option>${escapeHtml(h)}</option>`; });
            if(biHeaders.length > 1) sY.selectedIndex = 1;
            document.getElementById('bi-controls').style.display = 'block';
            const biEmpty = document.getElementById('bi-empty-state'); if(biEmpty) biEmpty.style.display = 'none';
            const biCanvasEl = document.getElementById('biCanvas'); if(biCanvasEl) biCanvasEl.style.display = 'block';
            biDrilldownFilter = null;
            const clearBtn = document.getElementById('bi-clear-drilldown-btn'); if(clearBtn) clearBtn.style.display = 'none';
            updateBIFilterValues();
            renderBIDataTable();
            renderSavedBIViewsList();
        }

        function updateBIFilterValues() {
            const col = document.getElementById('bi-filter-col').value;
            const sVal = document.getElementById('bi-filter-value');
            if(!col) { sVal.innerHTML = '<option value="">todos</option>'; sVal.disabled = true; updateBIChart(); return; }
            sVal.disabled = false;
            const uniqueVals = [...new Set(biData.map(r => r[col]))].sort();
            sVal.innerHTML = '<option value="">todos</option>' + uniqueVals.map(v => `<option>${escapeHtml(v)}</option>`).join('');
            updateBIChart();
        }

        function renderBIDataTable() {
            const card = document.getElementById('bi-data-card');
            const container = document.getElementById('bi-data-table-container');
            if(!container || !card) return;
            if(biData.length === 0) { card.style.display = 'none'; container.innerHTML = ''; return; }
            card.style.display = 'block';
            let filteredData = biData;
            if(biDrilldownFilter) filteredData = biData.filter(r => String(r[biDrilldownFilter.col] || 'N/A') === String(biDrilldownFilter.val));
            const rows = filteredData.slice(0, 50);
            let html = '<div class="table-container"><table><thead><tr>' + biHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
            rows.forEach(r => { html += '<tr>' + biHeaders.map(h => `<td>${r[h] !== undefined && r[h] !== null ? escapeHtml(r[h]) : '-'}</td>`).join('') + '</tr>'; });
            html += '</tbody></table></div>';
            if(biDrilldownFilter) html += `<p class="support-note" style="margin-top:10px;">filtrado por ${escapeHtml(biDrilldownFilter.col)} = ${escapeHtml(String(biDrilldownFilter.val))} (${filteredData.length} linha${filteredData.length === 1 ? '' : 's'}).</p>`;
            else if(filteredData.length > 50) html += `<p class="support-note" style="margin-top:10px;">mostrando as primeiras 50 de ${filteredData.length} linhas.</p>`;
            container.innerHTML = html;
        }

        function applyBIDrilldown(col, val) {
            biDrilldownFilter = { col, val };
            renderBIDataTable();
            const btn = document.getElementById('bi-clear-drilldown-btn');
            if(btn) btn.style.display = 'inline-block';
        }

        function clearBIDrilldown() {
            biDrilldownFilter = null;
            renderBIDataTable();
            const btn = document.getElementById('bi-clear-drilldown-btn');
            if(btn) btn.style.display = 'none';
        }

        function renderSavedBIViewsList() {
            const sel = document.getElementById('bi-saved-views');
            if(!sel) return;
            const views = (appDB.biSavedViews && appDB.biSavedViews[appDB.currentCompanyId]) || [];
            sel.innerHTML = '<option value="">selecione...</option>' + views.map((v, i) => `<option value="${i}">${escapeHtml(v.name)}</option>`).join('');
        }

        function saveCurrentBIView() {
            const name = prompt('Nome para esta visão:');
            if(!name) return;
            if(!appDB.biSavedViews) appDB.biSavedViews = {};
            if(!appDB.biSavedViews[appDB.currentCompanyId]) appDB.biSavedViews[appDB.currentCompanyId] = [];
            const view = {
                name: name.trim(),
                xCol: document.getElementById('bi-x').value,
                yCol: document.getElementById('bi-y').value,
                agg: document.getElementById('bi-agg').value,
                type: document.getElementById('bi-type').value,
                filterCol: document.getElementById('bi-filter-col').value,
                filterVal: document.getElementById('bi-filter-value').value,
                benchmark: document.getElementById('bi-benchmark').value
            };
            appDB.biSavedViews[appDB.currentCompanyId].push(view);
            saveToCloud();
            renderSavedBIViewsList();
            showToast('Visão salva.');
        }

        function loadSavedBIView(idxRaw) {
            if(idxRaw === '') return;
            const idx = parseInt(idxRaw, 10);
            const views = (appDB.biSavedViews && appDB.biSavedViews[appDB.currentCompanyId]) || [];
            const view = views[idx];
            if(!view) return;
            document.getElementById('bi-x').value = view.xCol;
            document.getElementById('bi-y').value = view.yCol;
            document.getElementById('bi-agg').value = view.agg;
            document.getElementById('bi-type').value = view.type;
            document.getElementById('bi-filter-col').value = view.filterCol;
            updateBIFilterValues();
            document.getElementById('bi-filter-value').value = view.filterVal;
            document.getElementById('bi-benchmark').value = view.benchmark || '';
            updateBIChart();
        }

        function renderBIInsight(labels, values, mainLabel, aggType) {
            const el = document.getElementById('bi-insight');
            if(!el) return;
            if(!values || values.length === 0) { el.textContent = ''; return; }
            const total = values.reduce((a, b) => a + b, 0);
            let maxIdx = 0;
            values.forEach((v, i) => { if(v > values[maxIdx]) maxIdx = i; });
            const maxLabel = labels[maxIdx]; const maxVal = values[maxIdx];
            const pct = total > 0 ? (maxVal / total) * 100 : 0;
            const aggNames = { sum: 'soma', avg: 'média', count: 'contagem', max: 'máximo', min: 'mínimo' };
            el.innerHTML = `<strong style="color: var(--text-main); font-style: normal;">${escapeHtml(String(maxLabel))}</strong> concentra o maior valor (${pct.toFixed(0)}% do total, ${aggNames[aggType] || ''} de ${maxVal.toLocaleString('pt-BR', {maximumFractionDigits: 2})}) entre ${labels.length} categoria${labels.length === 1 ? '' : 's'} analisadas.`;
        }

        function exportBIChart() {
            if(!biChartInstance) { showToast("Gere um gráfico primeiro."); return; }
            const link = document.createElement('a');
            link.href = biChartInstance.toBase64Image();
            link.download = `luppus_grafico_${Date.now()}.png`;
            link.click();
        }

        function aggregateBIRows(rowsSubset, xCol, yCol, aggType) {
            const groups = {};
            rowsSubset.forEach(row => {
                const xVal = row[xCol] || 'N/A';
                const rawVal = row[yCol];
                const yVal = typeof rawVal === 'number' ? rawVal : (parseFloat((rawVal||'0').toString().replace(/R\$/g,'').replace(/\./g,'').replace(/,/g,'.')) || 0);
                if(!groups[xVal]) groups[xVal] = []; groups[xVal].push(yVal);
            });
            const grouped = {};
            Object.keys(groups).forEach(k => {
                const arr = groups[k];
                if(aggType === 'avg') grouped[k] = arr.reduce((a,b) => a+b, 0) / arr.length;
                else if(aggType === 'count') grouped[k] = arr.length;
                else if(aggType === 'max') grouped[k] = Math.max(...arr);
                else if(aggType === 'min') grouped[k] = Math.min(...arr);
                else grouped[k] = arr.reduce((a,b) => a+b, 0);
            });
            return grouped;
        }

        function updateBIChart() {
            const xCol = document.getElementById('bi-x').value; const yCol = document.getElementById('bi-y').value; const type = document.getElementById('bi-type').value;
            const aggType = document.getElementById('bi-agg').value;
            const filterCol = document.getElementById('bi-filter-col').value;
            const filterVal = document.getElementById('bi-filter-value').value;
            if(!xCol || !yCol) return;

            let rows = biData;
            if(filterCol && filterVal) rows = rows.filter(r => r[filterCol] === filterVal);

            const aggLabels = { sum: 'soma', avg: 'média', count: 'contagem', max: 'máximo', min: 'mínimo' };
            const grouped = aggregateBIRows(rows, xCol, yCol, aggType);
            let labels = Object.keys(grouped);
            let values = labels.map(l => grouped[l]);

            if(type === 'combo') {
                const combined = labels.map((l, i) => ({ l, v: values[i] })).sort((a, b) => b.v - a.v);
                labels = combined.map(c => c.l); values = combined.map(c => c.v);
            }

            const ctx = document.getElementById('biCanvas').getContext('2d');
            if(biChartInstance) biChartInstance.destroy();

            let biBg;
            if (type === 'pie') biBg = categoricalPalette(labels.length);
            else if (type === 'line') biBg = verticalGradient(ctx, '--champagne', 300, 0.35, 0);
            else biBg = verticalGradient(ctx, '--champagne', 300, 0.85, 0.25);

            const mainLabel = `${yCol} (${aggLabels[aggType]})`;
            const chartType = type === 'combo' ? 'bar' : type;
            const datasets = [{ label: mainLabel, data: values, backgroundColor: biBg, borderColor: cssVar('--champagne'), borderWidth: 2, fill: type !== 'pie', yAxisID: 'y' }];

            const comparePeriod = document.getElementById('bi-compare-period').checked;
            if(comparePeriod && type !== 'pie' && type !== 'combo') {
                const dateCol = biHeaders.find(h => /data|date/i.test(h));
                if(!dateCol) {
                    showToast('Nenhuma coluna de data encontrada para comparar períodos.');
                } else {
                    const now = new Date();
                    const curMonth = now.getMonth(), curYear = now.getFullYear();
                    let prevMonth = curMonth - 1, prevYear = curYear; if(prevMonth < 0) { prevMonth = 11; prevYear--; }
                    const parseAny = (v) => parseBRDate(v) || (v ? new Date(v) : null);
                    const curRows = rows.filter(r => { const d = parseAny(r[dateCol]); return d && d.getMonth() === curMonth && d.getFullYear() === curYear; });
                    const prevRows = rows.filter(r => { const d = parseAny(r[dateCol]); return d && d.getMonth() === prevMonth && d.getFullYear() === prevYear; });
                    const curG = aggregateBIRows(curRows, xCol, yCol, aggType);
                    const prevG = aggregateBIRows(prevRows, xCol, yCol, aggType);
                    values = labels.map(l => curG[l] || 0);
                    const prevValues = labels.map(l => prevG[l] || 0);
                    datasets[0].data = values;
                    datasets[0].label = mainLabel + ' (mês atual)';
                    datasets.push({ label: mainLabel + ' (mês anterior)', data: prevValues, backgroundColor: 'transparent', borderColor: cssVar('--text-muted'), borderWidth: 2, borderDash: [4, 3], fill: false, yAxisID: 'y' });
                }
            }

            if(values.length > 2 && type !== 'pie') {
                const n = values.length;
                const xs = values.map((_, i) => i);
                const meanX = xs.reduce((a, b) => a + b, 0) / n;
                const meanY = values.reduce((a, b) => a + b, 0) / n;
                let num = 0, den = 0;
                for(let i = 0; i < n; i++) { num += (xs[i] - meanX) * (values[i] - meanY); den += Math.pow(xs[i] - meanX, 2); }
                const slope = den !== 0 ? num / den : 0;
                const intercept = meanY - slope * meanX;
                const trendData = xs.map(x => slope * x + intercept);
                datasets.push({ label: 'Tendência', data: trendData, type: 'line', borderColor: cssVarAlpha('--champagne', 0.6), borderDash: [2, 2], pointRadius: 0, fill: false, yAxisID: 'y' });
            }

            const benchmarkRaw = document.getElementById('bi-benchmark').value;
            const benchmark = benchmarkRaw === '' ? null : parseFloat(benchmarkRaw);
            if(benchmark !== null && !isNaN(benchmark) && type !== 'pie') {
                datasets.push({ label: 'Meta/Referência', data: labels.map(() => benchmark), type: 'line', borderColor: cssVar('--danger'), borderDash: [3, 3], pointRadius: 0, fill: false, yAxisID: 'y' });
            }

            let scalesConfig = { y: { grid: { color: cssVar('--border') } }, x: { grid: { display: false } } };
            if(type === 'combo') {
                const total = values.reduce((a, b) => a + b, 0);
                let cum = 0;
                const cumPct = values.map(v => { cum += v; return total > 0 ? (cum / total) * 100 : 0; });
                datasets.push({ label: '% acumulado', data: cumPct, type: 'line', borderColor: cssVar('--success'), backgroundColor: 'transparent', pointRadius: 3, fill: false, yAxisID: 'y1' });
                scalesConfig.y1 = { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: v => v + '%' } };
            }

            biChartInstance = new Chart(ctx, {
                type: chartType,
                data: { labels: labels, datasets: datasets },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    scales: type === 'pie' ? {} : scalesConfig,
                    plugins: { legend: { display: type === 'pie' || datasets.length > 1 } },
                    onClick: (evt, elements) => {
                        if(elements && elements.length > 0) {
                            const idx = elements[0].index;
                            applyBIDrilldown(xCol, labels[idx]);
                        }
                    }
                }
            });

            renderBIInsight(labels, values, mainLabel, aggType);
        }

        // --- WIPE E PDF ---
        function openWipeModal() { document.getElementById('wipe-overlay').style.display = 'flex'; }
        function closeWipeModal() { document.getElementById('wipe-overlay').style.display = 'none'; }
        function confirmWipe() {
            if (document.getElementById('wipe-pin-input').value === WIPE_PIN) {
                appDB.transactions[appDB.currentCompanyId] = []; appDB.spreadsheets[appDB.currentCompanyId] = []; appDB.vault[appDB.currentCompanyId] = []; saveToCloud(); closeWipeModal(); applySmartSearch(); renderVault(); showToast('Expurgo concluído.');
            } else { document.getElementById('wipe-error').style.display = 'block'; }
        }
        async function generatePDF() {
            document.getElementById('loading-text').innerText = "Gerando PDF..."; document.getElementById('loading-overlay').style.display = 'flex';
            const currentViewEl = document.querySelector('.view-section.active');
            const currentViewId = currentViewEl ? currentViewEl.id.replace('view-', '') : 'painel';
            const exportArea = document.getElementById('pdf-export-area'); exportArea.classList.add('pdf-mode');
            try {
                const { jsPDF } = window.jspdf; const pdf = new jsPDF('p', 'mm', 'a4'); window.scrollTo(0,0);
                // html2canvas needs a literal hex, not a CSS var() — keep this in sync with --graphite in style.css
                const canvas = await html2canvas(exportArea, { backgroundColor: '#121516', scale: 2 });
                pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdf.internal.pageSize.getWidth(), (canvas.height * pdf.internal.pageSize.getWidth()) / canvas.width);
                pdf.save(`LUPPUS_${Date.now()}.pdf`);
            } catch (error) { showToast("Erro PDF."); }
            finally { exportArea.classList.remove('pdf-mode'); document.getElementById('loading-overlay').style.display = 'none'; switchView(currentViewId); }
        }
