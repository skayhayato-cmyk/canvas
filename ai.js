// ============================================
// NEXA AI - AI AGENT NODE.JS
// Arsitektur: Perception → Reasoning Loop → Tools → Memory
// ============================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs').promises;
const path = require('path');

// ============================================
// KONFIGURASI
// ============================================
const CONFIG = {
    GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE', // Ganti dengan API key Anda
    MEMORY_FILE: './nexa_memory.json',
    MAX_SEARCH_RESULTS: 5,
    MODEL_NAME: 'gemini-2.0-flash',
    CREATOR: 'CodeMaster',
    AGENT_NAME: 'Nexa AI'
};

// ============================================
// 4. MEMORY SYSTEM
// ============================================
class MemorySystem {
    constructor() {
        this.shortTerm = [];      // Conversation history
        this.longTerm = {};       // Knowledge base
        this.userProfile = {};    // User preferences
        this.memoryPath = CONFIG.MEMORY_FILE;
    }

    async load() {
        try {
            const data = await fs.readFile(this.memoryPath, 'utf8');
            const parsed = JSON.parse(data);
            this.longTerm = parsed.longTerm || {};
            this.userProfile = parsed.userProfile || {};
            console.log('🧠 Memori dimuat dari disk.');
        } catch {
            console.log('🧠 Memori baru dibuat.');
        }
    }

    async save() {
        const data = {
            longTerm: this.longTerm,
            userProfile: this.userProfile,
            lastUpdated: new Date().toISOString()
        };
        await fs.writeFile(this.memoryPath, JSON.stringify(data, null, 2));
    }

    addToShortTerm(role, content) {
        this.shortTerm.push({ role, content, timestamp: Date.now() });
        if (this.shortTerm.length > 20) this.shortTerm.shift(); // Keep last 20
    }

    getContext() {
        return this.shortTerm.map(m => `${m.role}: ${m.content}`).join('\n');
    }

    storeKnowledge(key, value) {
        this.longTerm[key] = {
            value,
            storedAt: new Date().toISOString()
        };
    }

    getKnowledge(key) {
        return this.longTerm[key]?.value || null;
    }

    updateProfile(key, value) {
        this.userProfile[key] = value;
    }
}

// ============================================
// 5. TOOLS & ACTIONS LAYER
// ============================================
class ToolsLayer {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async initBrowser() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1366, height: 768 });
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }

    // Tool: Google Search dengan multiple tabs
    async searchGoogle(query, numResults = CONFIG.MAX_SEARCH_RESULTS) {
        console.log(`🔍 Mencari di Google: "${query}"`);
        await this.initBrowser();
        
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        await this.page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Tunggu hasil muncul
        await this.page.waitForSelector('div#search, div#rso', { timeout: 10000 });
        
        // Ambil hasil pencarian
        const results = await this.page.evaluate((max) => {
            const items = [];
            const elements = document.querySelectorAll('div.g, div[data-ved]');
            
            for (let i = 0; i < Math.min(elements.length, max); i++) {
                const el = elements[i];
                const titleEl = el.querySelector('h3');
                const linkEl = el.querySelector('a');
                const snippetEl = el.querySelector('div.VwiC3b, span.aCOpRe');
                
                if (titleEl && linkEl) {
                    items.push({
                        title: titleEl.innerText,
                        url: linkEl.href,
                        snippet: snippetEl ? snippetEl.innerText : ''
                    });
                }
            }
            return items;
        }, numResults);

        // Buka banyak tab untuk hasil pencarian
        console.log(`📑 Membuka ${results.length} tab untuk eksplorasi...`);
        const pages = [this.page];
        
        for (let i = 1; i < Math.min(results.length, 3); i++) {
            const newPage = await this.browser.newPage();
            try {
                await newPage.goto(results[i].url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                pages.push(newPage);
            } catch (e) {
                console.log(`⚠️ Gagal membuka: ${results[i].url}`);
            }
        }

        // Ambil konten dari semua tab
        const allContent = [];
        for (let i = 0; i < pages.length; i++) {
            try {
                const content = await pages[i].evaluate(() => {
                    // Ambil teks utama dari halaman
                    const article = document.querySelector('article, main, [role="main"], .content, #content');
                    const body = article || document.body;
                    return body.innerText.substring(0, 3000); // Limit 3000 chars
                });
                allContent.push({
                    source: results[i]?.title || `Tab ${i + 1}`,
                    url: results[i]?.url || '',
                    content: content
                });
            } catch (e) {
                console.log(`⚠️ Gagal ekstrak konten tab ${i + 1}`);
            }
        }

        return {
            query,
            results,
            detailedContent: allContent,
            summary: results.map(r => `• ${r.title}: ${r.snippet}`).join('\n')
        };
    }

    // Tool: Simpan file
    async saveFile(filename, content) {
        const filepath = path.join('./output', filename);
        await fs.mkdir('./output', { recursive: true });
        await fs.writeFile(filepath, content);
        return filepath;
    }

    // Tool: Baca file
    async readFile(filepath) {
        return await fs.readFile(filepath, 'utf8');
    }

    // Tool: Analisis data sederhana
    analyzeData(data) {
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        return {
            length: text.length,
            wordCount: text.split(/\s+/).length,
            hasNumbers: /\d/.test(text),
            hasLinks: /https?:\/\//.test(text)
        };
    }
}

// ============================================
// 2. PERCEPTION LAYER
// ============================================
class PerceptionLayer {
    constructor(memory) {
        this.memory = memory;
    }

    process(input) {
        console.log('👁️  Perception Layer: Menganalisis input...');
        
        // Intent Recognition
        const intent = this.recognizeIntent(input);
        
        // Entity Extraction
        const entities = this.extractEntities(input);
        
        // Context Understanding
        const context = this.understandContext(input, intent);
        
        return {
            rawInput: input,
            intent,
            entities,
            context,
            timestamp: Date.now(),
            needsSearch: intent.type === 'search' || intent.type === 'unknown' || intent.confidence < 0.6
        };
    }

    recognizeIntent(input) {
        const lower = input.toLowerCase();
        
        // Keyword matching untuk intent
        const intents = {
            search: ['cari', 'apa itu', 'siapa', 'bagaimana', 'mengapa', 'jelaskan', 'search', 'google', 'temukan'],
            code: ['buatkan', 'coding', 'script', 'program', 'kode', 'function', 'class'],
            file: ['simpan', 'save', 'baca', 'file', 'dokumen'],
            chat: ['halo', 'hai', 'apa kabar', 'terima kasih', 'bye'],
            memory: ['ingat', 'remember', 'simpan info', 'catat']
        };

        let bestIntent = { type: 'unknown', confidence: 0 };
        
        for (const [type, keywords] of Object.entries(intents)) {
            const matches = keywords.filter(k => lower.includes(k)).length;
            const confidence = matches / Math.max(keywords.length * 0.3, 1);
            if (confidence > bestIntent.confidence) {
                bestIntent = { type, confidence: Math.min(confidence, 1) };
            }
        }

        // Jika ada tanda tanya atau panjang > 10, kemungkinan search
        if (input.includes('?') || input.length > 10) {
            bestIntent.confidence += 0.2;
        }

        return bestIntent;
    }

    extractEntities(input) {
        const entities = [];
        
        // Extract URLs
        const urls = input.match(/https?:\/\/[^\s]+/g);
        if (urls) entities.push(...urls.map(u => ({ type: 'url', value: u })));
        
        // Extract emails
        const emails = input.match(/\S+@\S+\.\S+/g);
        if (emails) entities.push(...emails.map(e => ({ type: 'email', value: e })));
        
        // Extract quoted strings (potential search queries)
        const quotes = input.match(/"([^"]+)"/g);
        if (quotes) entities.push(...quotes.map(q => ({ type: 'query', value: q.replace(/"/g, '') })));
        
        // Extract potential topics (capitalized words)
        const topics = input.match(/\b[A-Z][a-zA-Z]{2,}\b/g);
        if (topics) {
            const unique = [...new Set(topics)];
            entities.push(...unique.map(t => ({ type: 'topic', value: t })));
        }

        return entities;
    }

    understandContext(input, intent) {
        const history = this.memory.getContext();
        const isFollowUp = history.length > 0 && 
            (input.toLowerCase().startsWith('dan') || 
             input.toLowerCase().startsWith('lalu') ||
             input.toLowerCase().startsWith('terus') ||
             input.length < 15);

        return {
            isFollowUp,
            conversationHistory: history,
            userPreference: this.memory.userProfile,
            urgency: input.includes('!') || input.includes('cepat') || input.includes('segera')
        };
    }
}

// ============================================
// 3. AGENT BRAIN (REASONING LOOP)
// ============================================
class AgentBrain {
    constructor(perception, tools, memory, gemini) {
        this.perception = perception;
        this.tools = tools;
        this.memory = memory;
        this.gemini = gemini;
    }

    // 3.1 THINK: Analyze goal & decide next step
    async think(perception) {
        console.log('🧠 THINK: Menganalisis tujuan...');
        
        const prompt = `
Kamu adalah Nexa AI, asisten pintar buatan CodeMaster.
Analisis permintaan user dan tentukan strategi terbaik.

Input user: "${perception.rawInput}"
Intent: ${perception.intent.type} (confidence: ${perception.intent.confidence})
Entities: ${JSON.stringify(perception.entities)}
Context: ${JSON.stringify(perception.context)}

Jika pertanyaan memerlukan fakta terkini atau informasi detail, rekomendasikan pencarian Google.
Jika pertanyaan umum atau personal, jawab langsung.

Respons dalam format JSON:
{
    "strategy": "search|direct|code|file",
    "reasoning": "penjelasan singkat",
    "searchQuery": "query untuk Google jika perlu search",
    "needsTools": true/false
}`;

        try {
            const result = await this.gemini.generateContent(prompt);
            const text = result.response.text();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            const decision = jsonMatch ? JSON.parse(jsonMatch[0]) : {
                strategy: perception.needsSearch ? 'search' : 'direct',
                reasoning: 'Default strategy',
                searchQuery: perception.rawInput,
                needsTools: perception.needsSearch
            };
            
            return decision;
        } catch (e) {
            return {
                strategy: perception.needsSearch ? 'search' : 'direct',
                reasoning: 'Fallback strategy',
                searchQuery: perception.rawInput,
                needsTools: perception.needsSearch
            };
        }
    }

    // 3.2 PLAN: Break down goal into actionable steps
    async plan(decision, perception) {
        console.log('📋 PLAN: Merencanakan langkah...');
        
        const steps = [];
        
        if (decision.strategy === 'search') {
            steps.push({ action: 'searchGoogle', params: decision.searchQuery || perception.rawInput });
            steps.push({ action: 'analyzeResults', params: null });
            steps.push({ action: 'synthesize', params: null });
        } else if (decision.strategy === 'code') {
            steps.push({ action: 'generateCode', params: perception.rawInput });
            steps.push({ action: 'validateCode', params: null });
        } else if (decision.strategy === 'file') {
            steps.push({ action: 'fileOperation', params: perception.rawInput });
        } else {
            steps.push({ action: 'respondDirectly', params: perception.rawInput });
        }

        return { steps, currentStep: 0 };
    }

    // 3.3 ACT: Choose tool/action to execute
    async act(step, perception) {
        console.log(`⚡ ACT: Menjalankan ${step.action}...`);
        
        switch (step.action) {
            case 'searchGoogle':
                const searchResults = await this.tools.searchGoogle(step.params);
                this.memory.storeKnowledge(`search_${Date.now()}`, searchResults);
                return { type: 'search', data: searchResults };
            
            case 'analyzeResults':
                // Analisis hasil pencarian
                const lastSearch = Object.entries(this.memory.longTerm)
                    .filter(([k]) => k.startsWith('search_'))
                    .pop();
                if (lastSearch) {
                    const analysis = this.tools.analyzeData(lastSearch[1].detailedContent);
                    return { type: 'analysis', data: analysis };
                }
                return { type: 'analysis', data: null };
            
            case 'synthesize':
                const searchData = Object.entries(this.memory.longTerm)
                    .filter(([k]) => k.startsWith('search_'))
                    .pop()?.[1];
                return { type: 'synthesis', data: searchData };
            
            case 'respondDirectly':
                return { type: 'direct', data: step.params };
            
            default:
                return { type: 'unknown', data: step.params };
        }
    }

    // 3.4 OBSERVE: Collect results & evaluate outcome
    async observe(actionResult, perception) {
        console.log('🔍 OBSERVE: Mengevaluasi hasil...');
        
        const evaluation = {
            success: actionResult.data !== null,
            hasUsefulData: false,
            needsMoreSearch: false,
            confidence: 0
        };

        if (actionResult.type === 'search' && actionResult.data) {
            evaluation.hasUsefulData = actionResult.data.results.length > 0;
            evaluation.confidence = actionResult.data.results.length > 2 ? 0.8 : 0.5;
            evaluation.needsMoreSearch = actionResult.data.results.length === 0;
        } else if (actionResult.type === 'direct') {
            evaluation.confidence = 0.9;
            evaluation.hasUsefulData = true;
        }

        return evaluation;
    }

    // REASONING LOOP UTAMA
    async reasoningLoop(perception) {
        let iteration = 0;
        const maxIterations = 3;
        let context = { perception, results: [], evaluation: null };

        while (iteration < maxIterations) {
            console.log(`\n🔄 REASONING LOOP - Iterasi ${iteration + 1}/${maxIterations}`);
            
            // THINK
            const decision = await this.think(perception);
            
            // PLAN
            const plan = await this.plan(decision, perception);
            
            // ACT - jalankan semua steps
            for (const step of plan.steps) {
                const result = await this.act(step, perception);
                context.results.push(result);
            }
            
            // OBSERVE
            const lastResult = context.results[context.results.length - 1];
            context.evaluation = await this.observe(lastResult, perception);
            
            // Cek apakah goal tercapai
            if (context.evaluation.success && context.evaluation.confidence > 0.7) {
                console.log('✅ Goal tercapai!');
                break;
            }
            
            // Jika perlu search lagi dengan query berbeda
            if (context.evaluation.needsMoreSearch && iteration < maxIterations - 1) {
                perception.rawInput += ' (more detailed)';
            }
            
            iteration++;
        }

        return context;
    }
}

// ============================================
// 6. RESPONSE GENERATION
// ============================================
class ResponseGeneration {
    constructor(gemini, memory) {
        this.gemini = gemini;
        this.memory = memory;
    }

    async generate(context) {
        console.log('✨ RESPONSE GENERATION: Mensintesis jawaban...');
        
        const { perception, results, evaluation } = context;
        const searchData = results.find(r => r.type === 'search')?.data;
        const history = this.memory.getContext();

        let prompt;
        
        if (searchData) {
            // Jika ada hasil pencarian, sintesis dengan AI
            const sources = searchData.detailedContent.map(c => 
                `Sumber: ${c.source}\n${c.content.substring(0, 1000)}`
            ).join('\n\n---\n\n');

            prompt = `
Kamu adalah Nexa AI, asisten pintar yang dapat mencari informasi di Google.

PERTANYAAN USER: "${perception.rawInput}"

HASIL PENCARIAN GOOGLE:
${sources}

RINGKASAN HASIL:
${searchData.summary}

INSTRUKSI:
1. Jawab pertanyaan user berdasarkan hasil pencarian di atas
2. Sertakan sumber informasi
3. Jika informasi tidak cukup, katakan dengan jujur
4. Gunakan bahasa yang sama dengan pertanyaan user
5. Format jawaban dengan rapi menggunakan markdown

Jawaban:`;
        } else {
            // Jawaban langsung tanpa pencarian
            prompt = `
Kamu adalah Nexa AI, asisten pintar buatan CodeMaster.

PERTANYAAN USER: "${perception.rawInput}"

Konteks percakapan:
${history}

Jawab dengan natural, helpful, dan informatif. Gunakan bahasa yang sama dengan user.`;
        }

        try {
            const result = await this.gemini.generateContent(prompt);
            let response = result.response.text();

            // Tambahkan metadata jika ada pencarian
            if (searchData) {
                response += `\n\n---\n📚 **Sumber:** ${searchData.results.length} hasil pencarian Google`;
                response += `\n🔍 **Query:** "${searchData.query}"`;
            }

            return response;
        } catch (e) {
            return `Maaf, terjadi kesalahan saat memproses permintaan Anda. Error: ${e.message}`;
        }
    }
}

// ============================================
// 7. OUTPUT TO USER
// ============================================
class OutputLayer {
    formatResponse(text, type = 'text') {
        // Format dengan typing effect simulation
        return {
            content: text,
            type,
            timestamp: new Date().toISOString(),
            formatted: true
        };
    }

    printWelcome() {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     🤖  N E X A   A I  -  Powered by CodeMaster         ║
║                                                          ║
║     Arsitektur: Perception → Reasoning → Tools           ║
║     Fitur: Google Search Multi-Tab | Memory | Learning   ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝

Ketik pertanyaan Anda. Nexa akan:
  • Menganalisis intent & konteks
  • Mencari di Google jika perlu (banyak tab!)
  • Menyimpan memori percakapan
  • Memberikan jawaban terbaik

Perintah khusus:
  /clear  - Hapus memori percakapan
  /exit   - Keluar
  /memory - Lihat memori tersimpan

`);
    }

    printResponse(response) {
        console.log('\n' + '─'.repeat(60));
        console.log('🤖 NEXA AI:');
        console.log(response.content);
        console.log('─'.repeat(60) + '\n');
    }
}

// ============================================
// MAIN AGENT CONTROLLER
// ============================================
class NexaAI {
    constructor() {
        this.memory = new MemorySystem();
        this.tools = new ToolsLayer();
        this.perception = null;
        this.brain = null;
        this.responseGen = null;
        this.output = new OutputLayer();
        this.gemini = null;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    async initialize() {
        console.log('🚀 Memulai Nexa AI...');
        
        // Load memory
        await this.memory.load();
        
        // Init Gemini
        const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
        this.gemini = genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });
        
        // Init layers
        this.perception = new PerceptionLayer(this.memory);
        this.brain = new AgentBrain(this.perception, this.tools, this.memory, this.gemini);
        this.responseGen = new ResponseGeneration(this.gemini, this.memory);
        
        console.log('✅ Nexa AI siap!\n');
        this.output.printWelcome();
    }

    async processInput(userInput) {
        // Simpan ke short-term memory
        this.memory.addToShortTerm('user', userInput);

        // 2. PERCEPTION
        const perception = this.perception.process(userInput);
        console.log(`\n📊 Intent: ${perception.intent.type} (${(perception.intent.confidence * 100).toFixed(0)}%)`);
        console.log(`🔍 Butuh Search: ${perception.needsSearch ? 'Ya' : 'Tidak'}`);

        // 3. REASONING LOOP (Think → Plan → Act → Observe)
        const context = await this.brain.reasoningLoop(perception);

        // 6. RESPONSE GENERATION
        const response = await this.responseGen.generate(context);

        // 7. OUTPUT
        const formatted = this.output.formatResponse(response);
        this.output.printResponse(formatted);

        // Save to memory
        this.memory.addToShortTerm('assistant', response);
        await this.memory.save();

        return response;
    }

    async run() {
        await this.initialize();

        const askQuestion = () => {
            this.rl.question('👤 Anda: ', async (input) => {
                const trimmed = input.trim();

                if (trimmed.toLowerCase() === '/exit') {
                    console.log('\n👋 Sampai jumpa! Memori disimpan.');
                    await this.tools.closeBrowser();
                    this.rl.close();
                    return;
                }

                if (trimmed.toLowerCase() === '/clear') {
                    this.memory.shortTerm = [];
                    console.log('🧠 Memori percakapan dihapus.\n');
                    askQuestion();
                    return;
                }

                if (trimmed.toLowerCase() === '/memory') {
                    console.log('\n🧠 SHORT-TERM MEMORY:');
                    console.log(this.memory.getContext() || '(kosong)');
                    console.log('\n📚 LONG-TERM KNOWLEDGE:');
                    console.log(Object.keys(this.memory.longTerm).join(', ') || '(kosong)');
                    console.log('');
                    askQuestion();
                    return;
                }

                if (!trimmed) {
                    askQuestion();
                    return;
                }

                try {
                    await this.processInput(trimmed);
                } catch (e) {
                    console.error('❌ Error:', e.message);
                }

                askQuestion();
            });
        };

        askQuestion();
    }
}

// ============================================
// FEEDBACK & LEARNING SYSTEM
// ============================================
class FeedbackLearning {
    constructor(memory) {
        this.memory = memory;
    }

    collectFeedback(userInput, aiResponse, rating) {
        // Simpan feedback untuk improvement
        const feedback = {
            input: userInput,
            response: aiResponse,
            rating,
            timestamp: Date.now()
        };
        
        // Update user profile berdasarkan feedback
        if (rating > 3) {
            this.memory.updateProfile('satisfaction', (this.memory.userProfile.satisfaction || 0) + 1);
        }
        
        return feedback;
    }
}

// ============================================
// START APPLICATION
// ============================================
(async () => {
    const nexa = new NexaAI();
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\n👋 Mematikan Nexa AI...');
        await nexa.tools.closeBrowser();
        process.exit(0);
    });

    await nexa.run();
})();
