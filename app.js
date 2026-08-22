        const WIPE_PIN = "outdd102030"; 

        let appDB = {
            companies: [{ id: "default", name: "DADOS DA EMPRESA", info: "Luppus API" }],
            currentCompanyId: "default",
            transactions: { "default": [] },
            spreadsheets: {},
            vault: {} 
        };

        let chartInstance = null;
        let biChartInstance = null;
        let forecastChartInstance = null;
        let cloudDB = null;
        let pendingOFX = [];
        let filterTimeout; 
        
        let mySpreadsheet = null;
        let biData = [];
        let biHeaders = [];

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
        }

        window.onload = function() {
            try {
                const savedKeys = localStorage.getItem('luppus_node_keys');
                const savedMode = localStorage.getItem('luppus_client_mode');
                if(savedMode === 'true') isClientMode = true;

                if(savedKeys) {
                    const config = JSON.parse(savedKeys);
                    document.getElementById('login-overlay').style.display = 'none';
                    document.getElementById('loading-overlay').style.display = 'flex';
                    applyClientModeUI();
                    initFirebase(config);
                } else {
                    showLoginScreen();
                }
            } catch(e) {
                showLoginScreen();
            }
        };

        function showLoginScreen() {
            document.getElementById('login-overlay').style.display = 'flex';
            document.getElementById('loading-overlay').style.display = 'none';
            const entryDateEl = document.getElementById('entry-date');
            if(entryDateEl) entryDateEl.value = getTodayDate();
        }

        function startDemo() {
            const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
            const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };
            const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };

            appDB = {
                companies: [{ id: "demo", name: "LUPPUS Demo", info: "Ambiente de demonstração" }],
                currentCompanyId: "demo",
                transactions: { demo: [
                    { date: daysAgo(1), desc: "Pagamento Consultoria - Cliente Vetta", type: "in", amount: 18500 },
                    { date: daysAgo(2), desc: "Infraestrutura Cloud (AWS)", type: "out", amount: 2340.50 },
                    { date: daysAgo(4), desc: "Folha de Pagamento", type: "out", amount: 45200 },
                    { date: daysAgo(6), desc: "Receita Recorrente SaaS", type: "in", amount: 9800 },
                    { date: daysAgo(9), desc: "Consultoria Jurídica", type: "out", amount: 3100 },
                    { date: daysAgo(12), desc: "Novo Contrato - Cliente Aurora", type: "in", amount: 27400 },
                    { date: daysAgo(15), desc: "Licenças de Software", type: "out", amount: 1890 },
                    { date: daysAgo(20), desc: "Consultoria Estratégica", type: "in", amount: 15600 }
                ] },
                spreadsheets: {},
                vault: { demo: [
                    { name: "Contrato Social", category: "Contrato", date: daysAgo(30), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "contrato-social.txt" } },
                    { name: "Certidão Negativa de Débitos", category: "Certidão", date: daysAgo(60), expiry: daysAgo(5), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "certidao-negativa.txt" } },
                    { name: "Nota Fiscal - Consultoria", category: "Nota Fiscal", date: daysAgo(10), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "nota-fiscal.txt" } },
                    { name: "Certidão FGTS", category: "Certidão", date: daysAgo(45), expiry: daysFromNow(12), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "certidao-fgts.txt" } },
                    { name: "Comprovante de Endereço", category: "Comprovante", date: daysAgo(90), expiry: daysFromNow(200), file: { data: "data:text/plain;base64,RGVtb25zdHJhw6fDo28gTFVQUFVT", fname: "comprovante-endereco.txt" } }
                ] }
            };
            isClientMode = false;

            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('loading-overlay').style.display = 'none';
            const demoBanner = document.getElementById('demo-banner');
            if(demoBanner) demoBanner.style.display = 'block';

            const entryDateEl = document.getElementById('entry-date');
            if(entryDateEl) entryDateEl.value = getTodayDate();

            renderCompanyDropdown();
            applySmartSearch();
            renderVault();
        }

        function doKeyLogin() {
            const apiKeyInput = document.getElementById('api-key-input');
            const projIdInput = document.getElementById('project-id-input');
            
            if(!apiKeyInput || !projIdInput) return;
            
            const apiKey = apiKeyInput.value.trim();
            const projectId = projIdInput.value.trim();
            const clientCheckEl = document.getElementById('client-mode-check');
            const clientCheck = clientCheckEl ? clientCheckEl.checked : false;

            if(!apiKey || !projectId) {
                showLoginError("Por favor, preencha a API Key e o Project ID.");
                return;
            }

            const config = { apiKey: apiKey, authDomain: projectId + ".firebaseapp.com", projectId: projectId };
            isClientMode = clientCheck;

            try {
                localStorage.setItem('luppus_node_keys', JSON.stringify(config));
                localStorage.setItem('luppus_client_mode', clientCheck ? 'true' : 'false');
            } catch(e) {
                console.warn("Storage bloqueado. Rodando em RAM.");
                showToast("Sessão temporária iniciada.");
            }

            document.getElementById('login-error').style.display = 'none';
            document.getElementById('login-overlay').style.display = 'none';
            document.getElementById('loading-overlay').style.display = 'flex';

            applyClientModeUI();
            
            setTimeout(() => {
                initFirebase(config);
            }, 100);
        }

        function doLogout() {
            try {
                localStorage.removeItem('luppus_node_keys');
                localStorage.removeItem('luppus_client_mode');
            } catch(e) {}
            window.location.reload();
        }
        
        function applyClientModeUI() {
            if(isClientMode) {
                document.body.classList.add('client-mode');
            }
        }

        function initFirebase(config) {
            try {
                if (!firebase.apps.length) firebase.initializeApp(config);
                cloudDB = firebase.firestore();

                const docRef = cloudDB.collection("luppus_system").doc("node_state");
                docRef.onSnapshot((doc) => {
                    document.getElementById('loading-overlay').style.display = 'none';
                    const entryDateEl = document.getElementById('entry-date');
                    if(entryDateEl) entryDateEl.value = getTodayDate();

                    if (doc.exists) {
                        appDB = doc.data();
                        if(!appDB.currentCompanyId || !appDB.companies.find(c => c.id === appDB.currentCompanyId)) {
                            appDB.currentCompanyId = appDB.companies[0].id;
                        }
                        if(!appDB.spreadsheets) appDB.spreadsheets = {};
                        if(!appDB.vault) appDB.vault = {};
                        
                        renderCompanyDropdown();
                        applySmartSearch();
                        renderVault();
                        if(!isClientMode && document.getElementById('view-planilhas').classList.contains('active')) initSpreadsheet(); 
                    } else {
                        saveToCloud();
                        renderCompanyDropdown();
                        applySmartSearch();
                    }
                }, (error) => {
                    showLoginError("Acesso Negado.<br>Verifique as Regras de Segurança no Firebase.");
                    doLogoutFallback();
                });
            } catch(e) {
                showLoginError("Erro na Conexão:<br>" + e.message);
                doLogoutFallback();
            }
        }

        function doLogoutFallback() {
            document.getElementById('loading-overlay').style.display = 'none';
            document.getElementById('login-overlay').style.display = 'flex';
            try { localStorage.removeItem('luppus_node_keys'); localStorage.removeItem('luppus_client_mode'); } catch(e) {}
        }

        function saveToCloud() {
            if(cloudDB && !isClientMode) {
                cloudDB.collection("luppus_system").doc("node_state").set(appDB)
                .catch(err => showToast("Erro de Sincronização."));
            } else if (cloudDB && isClientMode) {
                 cloudDB.collection("luppus_system").doc("node_state").set(appDB);
            }
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

            const titles = { 'painel': 'visão geral', 'lancamentos': 'lançamentos', 'relatorios': 'auditoria smart', 'projecao':'forecasting algorítmico', 'planilhas': 'workspaces', 'bi': 'data studio', 'cofre': 'cofre corporativo', 'config': 'configurações', 'suporte': 'suporte' };
            document.getElementById('current-view-title').innerText = titles[viewId] || 'painel';

            if(viewId === 'planilhas') initSpreadsheet();
            if(viewId === 'projecao') updateForecasting();

            const navToggle = document.getElementById('nav-toggle');
            if(navToggle) navToggle.checked = false;
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
        function applySmartSearch() {
            clearTimeout(filterTimeout);
            filterTimeout = setTimeout(() => {
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

                const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
                let sortedTx = currentTx.map((t, i) => { return { ...t, originalIndex: i }; }).sort((a, b) => {
                    let da = a.date.split('/').reverse().join(''); let db = b.date.split('/').reverse().join('');
                    return db.localeCompare(da);
                });

                const filteredData = sortedTx.filter(t => {
                    return t.desc.toLowerCase().includes(filterDesc) && (filterType === 'all' || t.type === filterType);
                });
                renderData(filteredData);
            }, 300);
        }

        // --- RENDER TABLE & CHART ---
        function renderData(dataToRender) {
            let totalIn = 0, totalOut = 0;
            const tbody = document.querySelector('#history-table tbody');
            const recentList = document.getElementById('recent-transactions-list');
            
            if(tbody) tbody.innerHTML = '';
            if(recentList) recentList.innerHTML = '';

            dataToRender.forEach((t, index) => {
                if(t.type === 'in') totalIn += t.amount;
                if(t.type === 'out') totalOut += t.amount;
                
                let attachmentHtml = '<span style="color: var(--text-muted);">-</span>';
                if (t.receipt) { attachmentHtml = `<a href="${t.receipt.data}" download="${t.receipt.name}" class="attachment-link">doc</a>`; }

                if(tbody) {
                    const tr = document.createElement('tr');
                    let btnHtml = isClientMode ? '' : `<button class="icon-btn" onclick="deleteTransaction(${t.originalIndex})" aria-label="excluir lançamento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
                    tr.innerHTML = `
                        <td style="color: var(--text-muted);">${t.date}</td>
                        <td>${t.desc}</td>
                        <td style="color: ${t.type === 'in' ? 'var(--success)' : 'var(--danger)'};">${t.type === 'in' ? 'receita' : 'custo'}</td>
                        <td>R$ ${t.amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</td>
                        <td class="hide-on-pdf">${attachmentHtml}</td>
                        <td class="hide-on-pdf hide-client">${btnHtml}</td>
                    `;
                    tbody.appendChild(tr);
                }

                if(recentList && index < 5) {
                    const li = document.createElement('li');
                    li.className = 'recent-item';
                    li.innerHTML = `<span class="recent-desc">${t.desc.substring(0,25)}</span><span class="recent-val ${t.type}">${t.type === 'in' ? '+' : '-'}R$ ${t.amount.toLocaleString('pt-BR', {minimumFractionDigits: 2})}</span>`;
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

        // --- MOTOR DE PREVISIBILIDADE (FORECASTING) ---
        function updateForecasting() {
            const currentTx = appDB.transactions[appDB.currentCompanyId] || [];
            const forecastEmpty = document.getElementById('forecast-empty-state');
            const forecastCanvas = document.getElementById('forecastChart');
            if(currentTx.length === 0) {
                if(forecastEmpty) forecastEmpty.style.display = 'block';
                if(forecastCanvas) forecastCanvas.style.display = 'none';
                return;
            }
            if(forecastEmpty) forecastEmpty.style.display = 'none';
            if(forecastCanvas) forecastCanvas.style.display = 'block';

            let totalIn = 0, totalOut = 0;
            currentTx.forEach(t => { if(t.type === 'in') totalIn += t.amount; else totalOut += t.amount; });
            let currentCash = totalIn - totalOut;

            let dailyAvgCash = currentTx.length > 0 ? (currentCash / (currentTx.length * 2)) : 0; 
            let dataPoints = [currentCash]; let labels = ['Hoje'];
            
            for(let i=1; i<=3; i++) {
                dataPoints.push(currentCash + (dailyAvgCash * i * 10)); 
                labels.push('+' + (i*10) + 'd');
            }
            
            let projected30 = dataPoints[dataPoints.length-1];
            document.getElementById('forecast-30').innerText = `R$ ${projected30.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
            document.getElementById('forecast-30').style.color = projected30 >= 0 ? 'var(--success)' : 'var(--danger)';
            
            const riskEl = document.getElementById('forecast-risk');
            if(projected30 < 0) { riskEl.innerText = 'CRÍTICO'; riskEl.style.color = 'var(--danger)'; }
            else if(projected30 < (currentCash/2)) { riskEl.innerText = 'MÉDIO'; riskEl.style.color = 'var(--gold)'; }
            else { riskEl.innerText = 'BAIXO'; riskEl.style.color = 'var(--success)'; }

            const ctx = document.getElementById('forecastChart').getContext('2d');
            if(forecastChartInstance) forecastChartInstance.destroy();
            forecastChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: [{ label: 'Saldo Projetado', data: dataPoints, borderColor: cssVar('--champagne'), backgroundColor: verticalGradient(ctx, '--champagne', 300, 0.35, 0), fill: true, borderDash: [5, 5], tension: 0.4, pointBackgroundColor: cssVar('--champagne'), pointBorderColor: cssVar('--obsidian'), pointRadius: 4, pointHoverRadius: 6 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { grid: {color: cssVar('--border')} }, x: { grid: {display: false} } }, plugins: { legend: { display: false } } }
            });
        }

        // --- COFRE DIGITAL (VAULT) ---
        function parseBRDate(str) {
            if(!str) return null;
            const parts = str.trim().split('/');
            if(parts.length !== 3) return null;
            const d = new Date(parts[2], parts[1] - 1, parts[0]);
            return isNaN(d.getTime()) ? null : d;
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

        function processVaultUpload() {
            const name = document.getElementById('vault-name').value.trim();
            const category = document.getElementById('vault-category').value;
            const expiry = document.getElementById('vault-expiry').value.trim();
            const fileInput = document.getElementById('vault-file');
            const file = fileInput.files[0];

            if(!name || !file) { showToast("Preencha nome e anexe documento."); return; }
            if(file.size > 512000) { showToast("Limite de 500kb excedido."); return; }
            if(expiry && !parseBRDate(expiry)) { showToast("Data de validade inválida. Use DD/MM/AAAA."); return; }

            const reader = new FileReader();
            reader.onload = function(e) {
                if(!appDB.vault) appDB.vault = {};
                if(!appDB.vault[appDB.currentCompanyId]) appDB.vault[appDB.currentCompanyId] = [];
                appDB.vault[appDB.currentCompanyId].push({ date: getTodayDate(), name: name, category: category, expiry: expiry, file: { data: e.target.result, fname: file.name, mime: file.type } });
                saveToCloud();
                document.getElementById('vault-name').value = '';
                document.getElementById('vault-expiry').value = '';
                fileInput.value = '';
                renderVault();
                showToast("Salvo no Cofre.");
            };
            reader.readAsDataURL(file);
        }

        function renderVault() {
            const ul = document.getElementById('vault-list');
            if(!ul) return;
            ul.innerHTML = '';
            const allDocs = (appDB.vault && appDB.vault[appDB.currentCompanyId]) ? appDB.vault[appDB.currentCompanyId] : [];

            if(allDocs.length === 0) { ul.innerHTML = '<li class="empty-state">Nenhum documento no cofre ainda.</li>'; return; }

            const searchEl = document.getElementById('vault-search');
            const query = searchEl ? searchEl.value.trim().toLowerCase() : '';

            let matchCount = 0;
            allDocs.forEach((d, i) => {
                if(query && !d.name.toLowerCase().includes(query) && !(d.category || '').toLowerCase().includes(query)) return;
                matchCount++;

                const li = document.createElement('li');
                li.className = 'recent-item';
                let deleteBtnHtml = isClientMode ? '' : `<button class="icon-btn" onclick="deleteVault(${i})" aria-label="excluir documento"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
                const categoryChip = d.category ? `<span class="chip">${d.category}</span>` : '';
                const expiryChip = vaultExpiryBadge(d.expiry);
                li.innerHTML = `
                    <div>
                        <strong style="color: var(--text-main);">${d.name}</strong> <span style="color:var(--text-muted); font-size:10px;">(${d.date})</span>
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
        }

        function openVaultPreview(index) {
            const docs = appDB.vault[appDB.currentCompanyId];
            const d = docs[index];
            if(!d) return;
            document.getElementById('vault-preview-title').textContent = d.name;
            const body = document.getElementById('vault-preview-body');
            const mime = (d.file.mime || '').toLowerCase();
            const fname = (d.file.fname || '').toLowerCase();
            const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(fname);
            const isPdf = mime === 'application/pdf' || fname.endsWith('.pdf');
            if(isImage) {
                body.innerHTML = `<img src="${d.file.data}" alt="${d.name}">`;
            } else if(isPdf) {
                body.innerHTML = `<iframe src="${d.file.data}" title="${d.name}"></iframe>`;
            } else {
                body.innerHTML = `<p class="empty-state">Pré-visualização não disponível para este tipo de arquivo. Use o download.</p>`;
            }
            document.getElementById('vault-preview-overlay').style.display = 'flex';
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

        function processTransaction() {
            let dateVal = document.getElementById('entry-date').value.trim(); if(!dateVal) dateVal = getTodayDate();
            const desc = document.getElementById('desc').value.trim(); const type = document.getElementById('type').value; const amount = parseFloat(document.getElementById('amount').value);
            const file = document.getElementById('receipt').files[0];
            if (!desc || isNaN(amount) || amount <= 0) { showToast("Preencha descrição e valor."); return; }
            if (!file) { showToast("COMPLIANCE: Anexe comprovante."); return; }
            if (file.size > 512000) { showToast("Limite de 500KB excedido."); return; }

            const reader = new FileReader();
            reader.onload = function(e) {
                if (!appDB.transactions[appDB.currentCompanyId]) appDB.transactions[appDB.currentCompanyId] = [];
                appDB.transactions[appDB.currentCompanyId].push({ date: dateVal, desc, type, amount, receipt: { data: e.target.result, name: file.name } });
                saveToCloud(); applySmartSearch();
                document.getElementById('entry-date').value = getTodayDate(); document.getElementById('desc').value = ''; document.getElementById('amount').value = ''; document.getElementById('receipt').value = '';
                showToast("Lançamento Registrado.");
            };
            reader.readAsDataURL(file);
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
                        li.innerHTML = `<div><strong style="color:var(--text-main);">${t.date}</strong> | <span style="color:var(--text-muted);">${t.desc.substring(0,25)}</span><br><span style="color:${t.type==='in'?'var(--success)':'var(--danger)'};">R$ ${t.amount.toFixed(2)}</span></div><button class="outline-btn" style="padding:6px;" onclick="loadOFX(${i})">Validar</button>`;
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
        function initSpreadsheet() {
            const container = document.getElementById('spreadsheet-area');
            if(!container || typeof jspreadsheet === 'undefined') return;
            container.innerHTML = '';
            let data = [['Item', 'Qtd', 'Status'],['', '', ''],['', '', '']];
            if(appDB.spreadsheets && appDB.spreadsheets[appDB.currentCompanyId] && appDB.spreadsheets[appDB.currentCompanyId].length > 0) data = appDB.spreadsheets[appDB.currentCompanyId];
            mySpreadsheet = jspreadsheet(container, { data: data, minDimensions: [6, 10], defaultColWidth: 120, tableOverflow: true, tableHeight: '350px', tableWidth: '100%' });
        }
        function saveSpreadsheet() { if(mySpreadsheet){ appDB.spreadsheets[appDB.currentCompanyId] = mySpreadsheet.getData(); saveToCloud(); showToast('Planilha Salva.'); } }
        function exportSpreadsheet() { if(mySpreadsheet) mySpreadsheet.download(); }
        
        function handleCSVUpload() {
            const file = document.getElementById('bi-csv').files[0]; if(!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                const lines = e.target.result.split(/\r?\n/).filter(l => l.trim() !== '');
                if(lines.length < 2) return;
                const sep = lines[0].includes(';') ? ';' : ','; biHeaders = lines[0].split(sep).map(h => h.trim());
                biData = [];
                for(let i=1; i<lines.length; i++){
                    const cols = lines[i].split(sep).map(c => c.trim()); let rowObj = {};
                    biHeaders.forEach((h, idx) => { rowObj[h] = cols[idx]; }); biData.push(rowObj);
                }
                const sX = document.getElementById('bi-x'); const sY = document.getElementById('bi-y'); sX.innerHTML = ''; sY.innerHTML = '';
                biHeaders.forEach(h => { sX.innerHTML += `<option>${h}</option>`; sY.innerHTML += `<option>${h}</option>`; });
                if(biHeaders.length > 1) sY.selectedIndex = 1;
                document.getElementById('bi-controls').style.display = 'block';
                const biEmpty = document.getElementById('bi-empty-state'); if(biEmpty) biEmpty.style.display = 'none';
                const biCanvasEl = document.getElementById('biCanvas'); if(biCanvasEl) biCanvasEl.style.display = 'block';
                updateBIChart();
            }; reader.readAsText(file);
        }
        function updateBIChart() {
            const xCol = document.getElementById('bi-x').value; const yCol = document.getElementById('bi-y').value; const type = document.getElementById('bi-type').value;
            if(!xCol || !yCol) return;
            const grouped = {};
            biData.forEach(row => {
                const xVal = row[xCol] || 'N/A';
                const yVal = parseFloat((row[yCol]||'0').replace(/R\$/g,'').replace(/\./g,'').replace(/,/g,'.')) || 0;
                if(!grouped[xVal]) grouped[xVal] = 0; grouped[xVal] += yVal;
            });
            const ctx = document.getElementById('biCanvas').getContext('2d');
            if(biChartInstance) biChartInstance.destroy();
            const labels = Object.keys(grouped);
            let biBg;
            if (type === 'pie') biBg = categoricalPalette(labels.length);
            else if (type === 'line') biBg = verticalGradient(ctx, '--champagne', 300, 0.35, 0);
            else biBg = verticalGradient(ctx, '--champagne', 300, 0.85, 0.25);
            biChartInstance = new Chart(ctx, { type: type, data: { labels: labels, datasets: [{ label: yCol, data: Object.values(grouped), backgroundColor: biBg, borderColor: cssVar('--champagne'), borderWidth: 2, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, plugins:{legend:{display:type==='pie'}} } });
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
            document.getElementById('view-painel').style.display = 'block';
            const exportArea = document.getElementById('pdf-export-area'); exportArea.classList.add('pdf-mode');
            try {
                const { jsPDF } = window.jspdf; const pdf = new jsPDF('p', 'mm', 'a4'); window.scrollTo(0,0);
                // html2canvas needs a literal hex, not a CSS var() — keep this in sync with --graphite in style.css
                const canvas = await html2canvas(exportArea, { backgroundColor: '#121516', scale: 2 });
                pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdf.internal.pageSize.getWidth(), (canvas.height * pdf.internal.pageSize.getWidth()) / canvas.width);
                pdf.save(`LUPPUS_${Date.now()}.pdf`);
            } catch (error) { showToast("Erro PDF."); } 
            finally { exportArea.classList.remove('pdf-mode'); document.getElementById('loading-overlay').style.display = 'none'; switchView('relatorios'); }
        }
