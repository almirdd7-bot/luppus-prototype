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
        let categoryChartInstance = null;
        let cloudDB = null;
        let currentDocId = 'node_state'; // vira o UID de cada conta autenticada — ver initFirebase()
        let pendingOFX = [];
        let filterTimeout;

        let mySpreadsheet = null;
        let biData = [];
        let biHeaders = [];
        let spreadsheetUndoStash = {};

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

        function switchConfigTab(tab) {
            document.querySelectorAll('.config-tab').forEach(el => el.classList.remove('active'));
            const activeTab = document.querySelector('.config-tab[data-tab="' + tab + '"]');
            if(activeTab) activeTab.classList.add('active');

            document.querySelectorAll('.config-tab-panel').forEach(el => el.classList.remove('active'));
            const activePanel = document.getElementById('config-tab-' + tab);
            if(activePanel) activePanel.classList.add('active');
        }

        // --- SMART SEARCH (AI LITE) ---
        let auditSortColumn = 'date';
        let auditSortDir = 'desc';
        let auditNoAttachmentOnly = false;
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
            saveToCloud();
            input.value = '';
            renderCategoryUI();
            showToast('Categoria adicionada.');
        }

        function removeCategory(index) {
            const custom = appDB.customCategories[appDB.currentCompanyId] || [];
            custom.splice(index, 1);
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

            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const withIndex = currentTx.map((t, i) => ({ ...t, originalIndex: i }));

            let filteredData = withIndex.filter(t => {
                if(!t.desc.toLowerCase().includes(filterDesc)) return false;
                if(filterType !== 'all' && t.type !== filterType) return false;
                if(auditNoAttachmentOnly && t.receipt) return false;
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

        function exportAuditCSV() {
            if(!lastAuditFilteredData || lastAuditFilteredData.length === 0) { showToast("Nada para exportar."); return; }
            const header = ['Data', 'Descrição', 'Natureza', 'Valor'];
            const rows = lastAuditFilteredData.map(t => [t.date, t.desc.replace(/;/g, ','), t.type === 'in' ? 'Receita' : 'Custo', t.amount.toFixed(2).replace('.', ',')]);
            const csv = [header, ...rows].map(r => r.join(';')).join('\r\n');
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `luppus_auditoria_${Date.now()}.csv`;
            link.click();
            URL.revokeObjectURL(url);
        }

        // --- RENDER TABLE & CHART ---
        function renderData(dataToRender) {
            let totalIn = 0, totalOut = 0;
            const tbody = document.querySelector('#history-table tbody');
            const recentList = document.getElementById('recent-transactions-list');

            if(tbody) tbody.innerHTML = '';
            if(recentList) recentList.innerHTML = '';

            dataToRender.forEach((t, index) => {
                const isPending = !t.receipt;
                if(!isPending) {
                    if(t.type === 'in') totalIn += t.amount;
                    if(t.type === 'out') totalOut += t.amount;
                }

                let attachmentHtml = '<span style="color: var(--text-muted);">-</span>';
                if (t.receipt) { attachmentHtml = `<a href="${t.receipt.data}" download="${t.receipt.name}" class="attachment-link">doc</a>`; }

                const categoryChip = t.category ? ` <span class="chip" style="padding: 2px 8px; font-size: 9px; vertical-align: middle;">${escapeHtml(t.category)}</span>` : '';
                const pendingChip = isPending ? ` <span class="chip chip-danger" style="padding: 2px 8px; font-size: 9px; vertical-align: middle;">pendente</span>` : '';

                if(tbody) {
                    const tr = document.createElement('tr');
                    let actionHtml = '';
                    if(!isClientMode) {
                        actionHtml = `<div style="display:flex; gap:6px;">
                            <button class="icon-btn" onclick="editTransaction(${t.originalIndex})" aria-label="editar lançamento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                            <button class="icon-btn" onclick="deleteTransaction(${t.originalIndex})" aria-label="excluir lançamento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
                        </div>`;
                    }
                    tr.innerHTML = `
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
                if(tbody) tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum lançamento registrado ainda.</td></tr>';
            }

            const elIn = document.getElementById('total-in'); const elOut = document.getElementById('total-out'); const elNet = document.getElementById('net-cash');
            if(elIn) elIn.innerText = `R$ ${totalIn.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            if(elOut) elOut.innerText = `R$ ${totalOut.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            if(elNet) {
                elNet.innerText = `R$ ${(totalIn - totalOut).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
                elNet.style.color = (totalIn - totalOut) >= 0 ? 'var(--success)' : 'var(--danger)';
            }
            updateChart(totalIn, totalOut);
            if(document.getElementById('view-projecao').classList.contains('active')) updateForecasting();
            updatePainelAlerts();
            updatePainelCategoryChart();
            updatePainelForecastSummary();
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

            const pendingClass = pendingCount > 0 ? 'has-issues' : '';
            const expiringClass = expiringCount > 0 ? 'has-issues' : '';

            container.innerHTML = `
                <button type="button" class="painel-alert-item ${pendingClass}" onclick="goToPendingTransactions()">
                    <span class="painel-alert-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></span>
                    <span class="painel-alert-text"><strong>${pendingCount} lançamento${pendingCount === 1 ? '' : 's'} pendente${pendingCount === 1 ? '' : 's'}</strong><span>${pendingCount > 0 ? 'aguardando comprovante — não contam nos totais' : 'tudo contabilizado'}</span></span>
                </button>
                <button type="button" class="painel-alert-item ${expiringClass}" onclick="switchView('cofre')">
                    <span class="painel-alert-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span>
                    <span class="painel-alert-text"><strong>${expiringCount} documento${expiringCount === 1 ? '' : 's'} vencendo</strong><span>${expiringCount > 0 ? 'nos próximos 30 dias' : 'nenhum vencimento próximo'}</span></span>
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

            let totalIn = 0, totalOut = 0, oldestDate = null;
            currentTx.forEach(t => {
                if(!t.receipt) return;
                if(t.type === 'in') totalIn += t.amount; else totalOut += t.amount;
                const d = parseBRDate(t.date);
                if(d && (!oldestDate || d < oldestDate)) oldestDate = d;
            });
            const currentCash = totalIn - totalOut;

            const today = new Date(); today.setHours(0,0,0,0);
            const daysCovered = oldestDate ? Math.max(1, Math.round((today - oldestDate) / 86400000)) : 1;
            const dailyAvgIn = totalIn / daysCovered;
            const dailyAvgOut = totalOut / daysCovered;

            const extraCost = parseFloat(document.getElementById('forecast-extra-cost').value) || 0;
            const revenueChangePct = parseFloat(document.getElementById('forecast-revenue-change').value) || 0;
            const adjustedDailyIn = dailyAvgIn * (1 + revenueChangePct / 100);
            const adjustedDailyOut = dailyAvgOut + (extraCost / 30);
            const dailyNet = adjustedDailyIn - adjustedDailyOut;

            const horizon = parseInt(document.getElementById('forecast-horizon').value, 10) || 30;
            const steps = 6;
            let dataPoints = []; let labels = [];
            for(let i = 0; i <= steps; i++) {
                const day = Math.round((horizon / steps) * i);
                dataPoints.push(currentCash + dailyNet * day);
                labels.push(day === 0 ? 'Hoje' : '+' + day + 'd');
            }

            const projectedEnd = dataPoints[dataPoints.length - 1];
            document.getElementById('forecast-30-label').textContent = `saldo projetado (${horizon}d)`;
            document.getElementById('forecast-30').innerText = `R$ ${projectedEnd.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            document.getElementById('forecast-30').style.color = projectedEnd >= 0 ? 'var(--success)' : 'var(--danger)';

            const riskEl = document.getElementById('forecast-risk');
            if(projectedEnd < 0) { riskEl.innerText = 'CRÍTICO'; riskEl.style.color = 'var(--danger)'; }
            else if(projectedEnd < (currentCash/2)) { riskEl.innerText = 'MÉDIO'; riskEl.style.color = 'var(--gold)'; }
            else { riskEl.innerText = 'BAIXO'; riskEl.style.color = 'var(--success)'; }

            const thresholdRaw = document.getElementById('forecast-threshold').value;
            const threshold = thresholdRaw === '' ? null : parseFloat(thresholdRaw);
            const hasThreshold = threshold !== null && !isNaN(threshold);

            const ctx = document.getElementById('forecastChart').getContext('2d');
            if(forecastChartInstance) forecastChartInstance.destroy();
            const datasets = [{ label: 'Saldo Projetado', data: dataPoints, borderColor: cssVar('--champagne'), backgroundColor: verticalGradient(ctx, '--champagne', 300, 0.35, 0), fill: true, borderDash: [5, 5], tension: 0.4, pointBackgroundColor: cssVar('--champagne'), pointBorderColor: cssVar('--obsidian'), pointRadius: 4, pointHoverRadius: 6 }];
            if(hasThreshold) {
                datasets.push({ label: 'Limite Mínimo', data: labels.map(() => threshold), borderColor: cssVar('--danger'), borderDash: [3, 3], pointRadius: 0, fill: false, tension: 0 });
            }
            forecastChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { grid: {color: cssVar('--border')} }, x: { grid: {display: false} } }, plugins: { legend: { display: hasThreshold } } }
            });

            if(warningEl) {
                if(hasThreshold && dataPoints.some(v => v < threshold)) {
                    warningEl.style.display = 'block';
                    warningEl.textContent = `atenção: a projeção cruza o limite mínimo de R$ ${threshold.toLocaleString('pt-BR', {minimumFractionDigits: 2})} dentro do horizonte de ${horizon} dias.`;
                } else {
                    warningEl.style.display = 'none';
                }
            }
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

            fileToDataURLCompressed(file, MAX_FILE_BYTES).then((dataUrl) => {
                if(!appDB.vault) appDB.vault = {};
                if(!appDB.vault[appDB.currentCompanyId]) appDB.vault[appDB.currentCompanyId] = [];
                appDB.vault[appDB.currentCompanyId].push({ date: getTodayDate(), name: name, category: category, expiry: expiry, file: { data: dataUrl, fname: file.name, mime: file.type } });
                saveToCloud();
                document.getElementById('vault-name').value = '';
                document.getElementById('vault-expiry').value = '';
                fileInput.value = '';
                renderVault();
                showToast("Salvo no Cofre.");
            }).catch(() => showToast("Não foi possível processar o arquivo."))
            .finally(() => { vaultUploadInFlight = false; if(btn) { btn.disabled = false; btn.innerText = originalLabel; } });
        }

        function renderVault() {
            const ul = document.getElementById('vault-list');
            if(!ul) return;
            ul.innerHTML = '';
            const allDocs = (appDB.vault && appDB.vault[appDB.currentCompanyId]) ? appDB.vault[appDB.currentCompanyId] : [];

            if(allDocs.length === 0) { ul.innerHTML = '<li class="empty-state">Nenhum documento no cofre ainda.</li>'; updatePainelAlerts(); return; }

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
                li.innerHTML = `
                    <div>
                        <strong style="color: var(--text-main);">${escapeHtml(d.name)}</strong> <span style="color:var(--text-muted); font-size:10px;">(${d.date})</span>
                        ${(categoryChip || expiryChip) ? `<div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">${categoryChip}${expiryChip}</div>` : ''}
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                        <button class="icon-btn" onclick="openVaultPreview(${i})" aria-label="visualizar documento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>
                        <a href="${d.file.data}" download="${d.file.fname}" class="attachment-link">Download</a>
                        ${deleteBtnHtml}
                    </div>
                `;
                ul.appendChild(li);
            });

            if(matchCount === 0) { ul.innerHTML = '<li class="empty-state">Nenhum documento encontrado.</li>'; }
            updatePainelAlerts();
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
            openFilePreview(d.name, { data: d.file.data, mime: d.file.mime, fname: d.file.fname });
        }

        function closeVaultPreview() {
            document.getElementById('vault-preview-overlay').style.display = 'none';
            document.getElementById('vault-preview-body').innerHTML = '';
        }

        function deleteVault(index) {
            if(confirm("Excluir documento do cofre?")) { appDB.vault[appDB.currentCompanyId].splice(index, 1); saveToCloud(); renderVault(); }
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

            const finish = (receiptObj) => {
                if (!appDB.transactions[appDB.currentCompanyId]) appDB.transactions[appDB.currentCompanyId] = [];
                const txArray = appDB.transactions[appDB.currentCompanyId];
                const wasEditing = editingTransactionIndex !== null;

                if(wasEditing) {
                    const existing = txArray[editingTransactionIndex];
                    txArray[editingTransactionIndex] = { date: dateVal, desc, type, amount, category, recurring: existing.recurring, receipt: receiptObj || existing.receipt };
                    showToast(receiptObj || existing.receipt ? "Lançamento atualizado." : "Lançamento atualizado — ainda pendente.");
                } else {
                    txArray.push({ date: dateVal, desc, type, amount, category, recurring: recurring || false, receipt: receiptObj || null });
                    showToast(receiptObj ? "Lançamento registrado." : "Lançamento registrado como pendente — anexe o comprovante depois.");
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
            if(confirm("Excluir lançamento?")) { appDB.transactions[appDB.currentCompanyId].splice(index, 1); saveToCloud(); applySmartSearch(); }
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
            estoque: [['Item', 'Quantidade', 'Estoque Mínimo', 'Status'],['', '', '', '']],
            pagamentos: [['Fornecedor', 'Vencimento', 'Valor', 'Pago?'],['', '', '', '']],
            recebimentos: [['Cliente', 'Vencimento', 'Valor', 'Recebido?'],['', '', '', '']],
            fornecedores: [['Fornecedor', 'Contato', 'Categoria', 'Aprovado?'],['', '', '', '']],
            contratos: [['Contrato', 'Cliente/Fornecedor', 'Vigência até', 'Status'],['', '', '', '']],
            planoContas: [['Código', 'Conta', 'Categoria', 'Tipo'],['', '', '', '']],
            reembolsos: [['Colaborador', 'Data', 'Categoria', 'Valor', 'Aprovado?'],['', '', '', '', '']],
            compliance: [['Documento', 'Responsável', 'Prazo', 'Concluído?'],['', '', '', '']],
            ativos: [['Ativo', 'Categoria', 'Data de Aquisição', 'Valor', 'Status'],['', '', '', '', '']],
            onboarding: [['Cliente', 'Etapa', 'Responsável', 'Concluído?'],['', '', '', '']]
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
            el.textContent = sheet.name + (sheet.savedAt ? ` · salvo em ${sheet.savedAt}` : ' · ainda não salvo');
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
            sheet.data = mySpreadsheet.getData().map(row => row.slice());
            sheet.savedAt = getTodayDate() + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            saveToCloud();
            renderSheetMeta();
            showToast('Planilha salva.');
        }

        function exportSpreadsheet() { if(mySpreadsheet) mySpreadsheet.download(); }
        
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
            updateBIFilterValues();
            renderBIDataTable();
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
            const rows = biData.slice(0, 50);
            let html = '<div class="table-container"><table><thead><tr>' + biHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
            rows.forEach(r => { html += '<tr>' + biHeaders.map(h => `<td>${r[h] !== undefined && r[h] !== null ? escapeHtml(r[h]) : '-'}</td>`).join('') + '</tr>'; });
            html += '</tbody></table></div>';
            if(biData.length > 50) html += `<p class="support-note" style="margin-top:10px;">mostrando as primeiras 50 de ${biData.length} linhas.</p>`;
            container.innerHTML = html;
        }

        function exportBIChart() {
            if(!biChartInstance) { showToast("Gere um gráfico primeiro."); return; }
            const link = document.createElement('a');
            link.href = biChartInstance.toBase64Image();
            link.download = `luppus_grafico_${Date.now()}.png`;
            link.click();
        }

        function updateBIChart() {
            const xCol = document.getElementById('bi-x').value; const yCol = document.getElementById('bi-y').value; const type = document.getElementById('bi-type').value;
            const aggType = document.getElementById('bi-agg').value;
            const filterCol = document.getElementById('bi-filter-col').value;
            const filterVal = document.getElementById('bi-filter-value').value;
            if(!xCol || !yCol) return;

            let rows = biData;
            if(filterCol && filterVal) rows = rows.filter(r => r[filterCol] === filterVal);

            const groups = {};
            rows.forEach(row => {
                const xVal = row[xCol] || 'N/A';
                const rawVal = row[yCol];
                const yVal = typeof rawVal === 'number' ? rawVal : (parseFloat((rawVal||'0').toString().replace(/R\$/g,'').replace(/\./g,'').replace(/,/g,'.')) || 0);
                if(!groups[xVal]) groups[xVal] = []; groups[xVal].push(yVal);
            });
            const aggLabels = { sum: 'soma', avg: 'média', count: 'contagem', max: 'máximo', min: 'mínimo' };
            const grouped = {};
            Object.keys(groups).forEach(k => {
                const arr = groups[k];
                if(aggType === 'avg') grouped[k] = arr.reduce((a,b) => a+b, 0) / arr.length;
                else if(aggType === 'count') grouped[k] = arr.length;
                else if(aggType === 'max') grouped[k] = Math.max(...arr);
                else if(aggType === 'min') grouped[k] = Math.min(...arr);
                else grouped[k] = arr.reduce((a,b) => a+b, 0);
            });
            const ctx = document.getElementById('biCanvas').getContext('2d');
            if(biChartInstance) biChartInstance.destroy();
            const labels = Object.keys(grouped);
            let biBg;
            if (type === 'pie') biBg = categoricalPalette(labels.length);
            else if (type === 'line') biBg = verticalGradient(ctx, '--champagne', 300, 0.35, 0);
            else biBg = verticalGradient(ctx, '--champagne', 300, 0.85, 0.25);
            biChartInstance = new Chart(ctx, { type: type, data: { labels: labels, datasets: [{ label: `${yCol} (${aggLabels[aggType]})`, data: Object.values(grouped), backgroundColor: biBg, borderColor: cssVar('--champagne'), borderWidth: 2, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, plugins:{legend:{display:type==='pie'}} } });
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
