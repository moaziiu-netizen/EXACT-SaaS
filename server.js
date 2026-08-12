require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware: Membenarkan frontend berhubung dengan backend
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
// Sambungan ke Pangkalan Data Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -----------------------------------------------------
// LALUAN API PERTAMA KITA (Test Route)
// -----------------------------------------------------
app.get('/', (req, res) => {
    res.send('Pelayan EXACT-SaaS kini beroperasi dengan jayanya!');
});

// -----------------------------------------------------
// LALUAN API: Tarik Jadual Bertugas Mengikut Universiti
// -----------------------------------------------------
app.get('/api/jadual/:tenant_id', async (req, res) => {
    const tenantId = req.params.tenant_id;
    
    // Ini menggantikan arahan Google Sheets untuk mencari data
    const { data, error } = await supabase
        .from('duty_schedule')
        .select('*')
        .eq('tenant_id', tenantId);

    if (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    
    res.status(200).json({ success: true, data: data });
});
// -----------------------------------------------------
// LALUAN API: Masukkan Data Kehadiran (Check-In)
// -----------------------------------------------------
app.post('/api/checkin', async (req, res) => {
    // 1. Tangkap data yang dihantar oleh pelanggan (Frontend)
    const { tenant_id, staff_name, staff_id, venue } = req.body;

    // 2. Arahkan Supabase untuk masukkan (insert) data tersebut
    const { data, error } = await supabase
        .from('attendance')
        .insert([
            { 
                tenant_id: tenant_id, 
                staff_name: staff_name, 
                staff_id: staff_id, 
                venue: venue 
            }
        ]);

    // 3. Jika ada ralat, beritahu pelanggan
    if (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    
    // 4. Jika berjaya, hantar mesej sukses!
    res.status(200).json({ success: true, message: "Check-In Berjaya disimpan ke Supabase!" });
});
// Hidupkan Enjin Pelayan
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Pelayan sedang berjalan di http://localhost:${PORT}`);
});