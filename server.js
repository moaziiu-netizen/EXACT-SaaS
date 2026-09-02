require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');

// Tetapan multer untuk menyimpan fail secara sementara di dalam memori
const upload = multer({ storage: multer.memoryStorage() });
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Membenarkan pelayan memaparkan fail HTML anda
app.use(express.static(__dirname));

// Hubungan ke Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// =====================================================
// API 1: Tarik Data Konfigurasi & Semester
// =====================================================
app.get('/api/config/:tenant_id', async (req, res) => {
    const { tenant_id } = req.params;
    
    // 1. Tarik senarai Kampus/Venue/Sesi
    const { data: configData, error: configError } = await supabase
        .from('config')
        .select('*')
        .eq('tenant_id', tenant_id);

    if (configError) return res.status(400).json({ success: false, message: configError.message });

    // 2. Tarik senarai Semester
    const { data: semesterData, error: semError } = await supabase
        .from('semesters')
        .select('name, start_date, end_date')
        .eq('tenant_id', tenant_id);

    if (semError) return res.status(400).json({ success: false, message: semError.message });

    // Formatkan pembolehubah tarikh supaya sepadan dengan bacaan Frontend HTML anda
    const formattedSemesters = semesterData.map(s => ({
        name: s.name,
        start: s.start_date,
        end: s.end_date
    }));

    // 3. Hantar kedua-duanya sekaligus ke Frontend
    res.status(200).json({ 
        success: true, 
        configs: configData, 
        semesters: formattedSemesters 
    });
});

// =====================================================
// API 2: Carian Butiran Staf (Auto-fill Check-In)
// =====================================================
app.get('/api/staff-today/:tenant_id/:staff_id', async (req, res) => {
    try {
        const { tenant_id, staff_id } = req.params;
        
        const now = new Date();
        // Format YYYY-MM-DD untuk carian pangkalan data Supabase
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }); 
        // Format DD/MM/YYYY untuk paparan teks amaran pengguna
        const displayDateStr = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' }); 
        
        const { data, error } = await supabase
            .from('duty_schedule')
            .select('*')
            .eq('tenant_id', tenant_id)
            .eq('staff_id', staff_id)
            .eq('exam_date', todayStr); 

        if (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
        
        // Jika petugas TIADA dalam jadual pada hari ini (Guna displayDateStr di sini)
        if (!data || data.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: `Harap maklum. Petugas (ID: ${staff_id}) tiada dalam jadual peperiksaan pada hari ini (${displayDateStr}).` 
            });
        }
        
        const staffDetails = {
            name: data[0].staff_name,
            staffId: data[0].staff_id,
            role: data[0].role,
            campus: data[0].campus,
            venue: data[0].venue,
            session: data[0].exam_session,
            assignedCourses: []
        };
        
        data.forEach(row => {
            if (row.course_code) {
                staffDetails.assignedCourses.push({
                    code: row.course_code,
                    desc: row.course_desc,
                    st: row.start_time,
                    et: row.end_time,
                    ss: row.start_seat,
                    es: row.end_seat,
                    tot: row.total_student
                });
            }
        });
        
        res.status(200).json({ success: true, data: staffDetails });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 3: Check-In Bersepadu (Logik Masa, Anti-Spam & PASSCODE)
// =====================================================
app.post('/api/checkin', async (req, res) => {
    // KITA TAMBAH 'passcode' DI DALAM REQ.BODY INI
    const { tenant_id, staffId, name, role, campus, venue, session, remarks, passcode } = req.body;

    try {
        // --- KOD BAHARU: 1. PENGESAHAN PASSCODE DARI JADUAL 'config' ---
        const { data: configData, error: configErr } = await supabase
            .from('config')
            .select('passcode')
            .eq('tenant_id', tenant_id)
            .eq('campus', campus)
            .eq('venue', venue)
            .eq('exam_session', session)
            .single();

        // Jika admin ada menetapkan passcode untuk dewan ini, semak adakah ia sama
        if (configData && configData.passcode) {
            if (configData.passcode !== passcode) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Passcode (Kod Laluan) salah! Sila rujuk Ketua Pengawas di dalam dewan.' 
                });
            }
        }
        // ----------------------------------------------------------------

        // --- (KOD ASAL ANDA KEKAL DI BAWAH INI) ---
        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
        const currentTimeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });

        // Semak Pendua
        const { data: existingData, error: checkError } = await supabase
            .from('attendance')
            .select('id')
            .eq('tenant_id', tenant_id)
            .eq('staff_id', staffId)
            .eq('exam_date', todayStr)
            .eq('exam_session', session);

        if (checkError) throw checkError;
        if (existingData && existingData.length > 0) {
            return res.status(400).json({ success: false, duplicate: true, message: 'Anda telah pun mendaftar masuk untuk sesi ini hari ini.' });
        }

        // Dapatkan Waktu Mula
        const { data: dutyData, error: dutyError } = await supabase
            .from('duty_schedule')
            .select('start_time')
            .eq('tenant_id', tenant_id)
            .eq('staff_id', staffId)
            .eq('exam_date', todayStr)
            .eq('exam_session', session)
            .limit(1);

        if (dutyError) throw dutyError;
        if (!dutyData || dutyData.length === 0) {
            return res.status(404).json({ success: false, message: 'Jadual tugasan tidak ditemui untuk mengira masa.' });
        }

        const startTime = dutyData[0].start_time; 
        let status = 'On-Time';
        
        const sessionStartObj = new Date(`${todayStr}T${startTime}+08:00`); 
        const cutoffOnTime = new Date(sessionStartObj.getTime() - (46 * 60000));
        const cutoffGP = new Date(sessionStartObj.getTime() - (36 * 60000));

        if (now > cutoffGP) {
            status = 'Late';
        } else if (now > cutoffOnTime) {
            status = 'GP: On-Time';
        }

        // Simpan Data
        const { error: insertError } = await supabase
            .from('attendance')
            .insert([{
                tenant_id: tenant_id,
                staff_id: staffId,
                staff_name: name,
                role: role,
                campus: campus,
                venue: venue,
                exam_session: session,
                exam_date: todayStr,
                check_in_time: currentTimeStr,
                status: status,
                remarks: remarks || ''
            }]);

        if (insertError) throw insertError;

        res.status(200).json({ success: true, message: 'Check-In successfully recorded!', data: { checkInTime: currentTimeStr, status: status } });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
// =====================================================
// API 4: Penapis Jadual Utama (Home Dropdowns)
// =====================================================
app.get('/api/schedule-filters/:tenant_id', async (req, res) => {
    const { tenant_id } = req.params;
    
    const { data, error } = await supabase
        .from('duty_schedule')
        .select('campus, venue, exam_session')
        .eq('tenant_id', tenant_id);

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Tapis supaya tiada nama berulang (Unique values)
    const campuses = [...new Set(data.map(d => d.campus))].filter(Boolean).sort();
    const venues = [...new Set(data.map(d => d.venue))].filter(Boolean).sort();
    const sessions = [...new Set(data.map(d => d.exam_session))].filter(Boolean).sort();

    res.status(200).json({ success: true, campus: campuses, venue: venues, session: sessions });
});

// =====================================================
// API 5: Tarik Master Schedule (Home Table) - VERSI 30 HARI
// =====================================================
app.post('/api/master-schedule', async (req, res) => {
    const { tenant_id, date, campus, venue, session, q } = req.body;
    
    let query = supabase.from('duty_schedule').select('*').eq('tenant_id', tenant_id);
    
    // --- LOGIK "TINGKAP MASA" (60 Hari Lepas - 30 Hari Ke Hadapan) ---
    if (date) {
        query = query.eq('exam_date', date);
    } else {
        const today = new Date();
        
        // 60 Hari Ke Belakang
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - 60); 
        const startStr = startDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

        // 30 Hari Ke Hadapan
        const endDate = new Date(today);
        endDate.setDate(today.getDate() + 30);
        const endStr = endDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

        query = query.gte('exam_date', startStr).lte('exam_date', endStr);
    }
    // ---------------------------------------------------------------

    if (campus) query = query.eq('campus', campus);
    if (venue) query = query.eq('venue', venue);
    if (session) query = query.eq('exam_session', session);
    
    // Fungsi carian teks (Nama, ID, Kod Subjek)
    if (q) {
        query = query.or(`staff_name.ilike.%${q}%,staff_id.ilike.%${q}%,course_code.ilike.%${q}%,course_desc.ilike.%${q}%`);
    }
    
    // Letakkan limit sebagai langkah keselamatan tambahan pelayan
    query = query.limit(5000);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    // --- PROSES MENYUSUN DATA ---
    const grouped = new Map();
    data.forEach(r => {
        const key = `${r.exam_date}||${r.campus}||${r.exam_session}||${r.venue}||${r.staff_id}||${r.staff_name}||${r.role}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                dateIso: r.exam_date, campus: r.campus, session: r.exam_session,
                venue: r.venue, id: r.staff_id, name: r.staff_name, post: r.role,
                courses: new Map(), courseObjects: []
            });
        }
        if (r.course_code) {
            const st = r.start_time ? r.start_time.substring(0, 5) : '';
            const et = r.end_time ? r.end_time.substring(0, 5) : '';
            
            const courseHtml = `<strong>${r.course_code}</strong> — ${r.course_desc}` +
                (st || et ? ` <span class="text-muted">(${st}-${et})</span>` : '') +
                (r.start_seat || r.end_seat ? ` <span class="text-muted">Seat: ${r.start_seat} to ${r.end_seat}</span>` : '') +
                (r.total_student ? ` <span class="text-muted">• ${r.total_student} students</span>` : '');
            
            grouped.get(key).courses.set(r.course_code, courseHtml);
            grouped.get(key).courseObjects.push({ 
                code: r.course_code, desc: r.course_desc, st, et, ss: r.start_seat, es: r.end_seat, tot: r.total_student 
            });
        }
    });

    // Sediakan susunan jadual untuk dihantar ke Frontend
    const outHeaders = ['Date','Campus','Session','Venue','ID','Name','Post','Courses'];
    const rows = [];
    grouped.forEach(g => {
        const coursesHtml = (g.courses.size > 0) ? Array.from(g.courses.values()).join('<br>') : '<span class="text-muted">—</span>';
        rows.push([g.dateIso, g.campus, g.session, g.venue, g.id, g.name, g.post, coursesHtml, g.courseObjects]);
    });

    // Susun mengikut tarikh
    rows.sort((a,b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
    res.status(200).json({ success: true, headers: outHeaders, rows });
});

// =====================================================
// API 6: Senarai Kehadiran Hari Ini (Untuk Check-Out)
// =====================================================
app.get('/api/attendees/:tenant_id/:campus/:venue/:session', async (req, res) => {
    const { tenant_id, campus, venue, session } = req.params;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    
    // Cari staf yang telah Check-In untuk sesi ini
    const { data, error } = await supabase
        .from('attendance')
        .select('staff_id, staff_name, role, check_out_time')
        .eq('tenant_id', tenant_id)
        .eq('campus', campus)
        .eq('venue', venue)
        .eq('exam_session', session)
        .eq('exam_date', today);

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Format data untuk HTML (Sama seperti App Script lama)
    const list = data.map(row => ({
        id: row.staff_id,
        name: row.staff_name,
        role: row.role,
        checkedOut: !!row.check_out_time // Akan jadi 'true' jika masa keluar sudah diisi
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.status(200).json({ success: true, attendees: list });
});

// =====================================================
// API 7: Senarai Kursus Sesi Ini (Pemulangan Skrip)
// =====================================================
app.get('/api/session-courses/:tenant_id/:campus/:venue/:session', async (req, res) => {
    const { tenant_id, campus, venue, session } = req.params;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });

    // 1. Kenal pasti subjek yang SUDAH dipulangkan sebelum ini
    const { data: attData } = await supabase
        .from('attendance')
        .select('course_code')
        .eq('tenant_id', tenant_id)
        .eq('exam_date', today)
        .eq('campus', campus)
        .eq('venue', venue)
        .eq('exam_session', session)
        .eq('returned_script', 'Yes');

    const returnedCodes = new Set();
    if (attData) {
        attData.forEach(row => {
            if (row.course_code) row.course_code.split(',').forEach(c => returnedCodes.add(c.trim()));
        });
    }

    // 2. Tarik semua subjek yang ditugaskan pada sesi ini
    const { data: schData, error } = await supabase
        .from('duty_schedule')
        .select('course_code, course_desc')
        .eq('tenant_id', tenant_id)
        .eq('exam_date', today)
        .eq('campus', campus)
        .eq('venue', venue)
        .eq('exam_session', session);

    if (error) return res.status(400).json({ success: false, message: error.message });

    // 3. Tapis: Hanya paparkan subjek yang BELUM dipulangkan
    const outMap = new Map();
    schData.forEach(row => {
        if (row.course_code && !returnedCodes.has(row.course_code)) {
            outMap.set(row.course_code, row.course_desc);
        }
    });

    const courses = Array.from(outMap.entries()).map(([code, desc]) => ({ code, desc }));
    res.status(200).json({ success: true, courses });
});

// =====================================================
// API 8: Simpan Rekod Check-Out 
// =====================================================
app.post('/api/checkout', async (req, res) => {
    const { tenant_id, campus, venue, session, staffIds, returnScript, courseItems } = req.body;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const nowTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });

    // Formatkan senarai subjek menjadi teks dipisahkan koma
    let cCodes = '', cDescs = '';
    if (returnScript === 'Yes' && Array.isArray(courseItems)) {
        cCodes = courseItems.map(c => c.code).join(', ');
        cDescs = courseItems.map(c => c.desc).join(', ');
    }

    // Kemas kini rekod dalam Supabase
    const { data, error } = await supabase
        .from('attendance')
        .update({
            check_out_time: nowTime,
            returned_script: returnScript || '',
            course_code: cCodes,
            course_desc: cDescs
        })
        .eq('tenant_id', tenant_id)
        .eq('exam_date', today)
        .eq('campus', campus)
        .eq('venue', venue)
        .eq('exam_session', session)
        .in('staff_id', staffIds); // Boleh kemas kini banyak staf serentak!

    if (error) return res.status(400).json({ success: false, message: error.message });

    res.status(200).json({ success: true, message: 'Check-out direkodkan dengan berjaya.' });
});
// =====================================================
// API 9: Carian Kursus Global (Modul Collection)
// =====================================================
app.get('/api/search-course/:tenant_id', async (req, res) => {
    const { tenant_id } = req.params;
    const { q } = req.query; // Apa yang pengguna taip

    if (!q) return res.status(200).json([]);

    const { data, error } = await supabase
        .from('duty_schedule')
        .select('course_code, course_desc')
        .eq('tenant_id', tenant_id)
        .or(`course_code.ilike.%${q}%,course_desc.ilike.%${q}%`); // Cari pada kod ATAU nama kursus

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Buang data pendua (sebab jadual tugas mungkin ada banyak baris untuk kursus yang sama)
    const uniqueCourses = [];
    const seen = new Set();
    data.forEach(row => {
        if (row.course_code && !seen.has(row.course_code)) {
            seen.add(row.course_code);
            uniqueCourses.push({ code: row.course_code, desc: row.course_desc });
        }
    });

    res.status(200).json(uniqueCourses);
});

// =====================================================
// API 10: Carian Staf Global (Modul Collection)
// =====================================================
app.get('/api/search-staff/:tenant_id/:staff_id', async (req, res) => {
    const { tenant_id, staff_id } = req.params;

    const { data, error } = await supabase
        .from('duty_schedule')
        .select('staff_name')
        .eq('tenant_id', tenant_id)
        .eq('staff_id', staff_id)
        .limit(1);

    if (error || !data || data.length === 0) {
        return res.status(404).json(null); // Tak jumpa
    }

    res.status(200).json({ name: data[0].staff_name });
});

// =====================================================
// API 11: Simpan Rekod Collection
// =====================================================
app.post('/api/collection', async (req, res) => {
    const { tenant_id, campus, venue, courseCode, courseName, quantity, remarks, name, staffId, repName, repId, phone } = req.body;
    
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const currentTimeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });

    // Tentukan ID akhir yang patut disimpan (Sama ada staf sendiri atau wakil)
    const finalId = repName ? repId : staffId;

    const { error } = await supabase
        .from('collection')
        .insert([{
            tenant_id: tenant_id,
            collection_date: todayStr,
            collection_time: currentTimeStr,
            campus: campus,
            venue: venue,
            course_code: courseCode,
            course_name: courseName,
            quantity: quantity,
            staff_name: name,
            rep_name: repName || '',
            contact_no: phone,
            remarks: remarks || '',
            staff_id: finalId
        }]);

    if (error) return res.status(400).json({ success: false, message: error.message });

    res.status(200).json({ success: true, message: 'Answer script collection recorded successfully.' });
});
// =====================================================
// API 12: Penjanaan Laporan (Modul Reports)
// =====================================================
app.post('/api/reports', async (req, res) => {
    const { tenant_id, startDate, endDate } = req.body;

    try {
        // 1. Tarik Data Jadual Tugasan (Untuk cari siapa Absent & No Telefon)
        const { data: schData } = await supabase
            .from('duty_schedule')
            .select('*')
            .eq('tenant_id', tenant_id)
            .gte('exam_date', startDate)
            .lte('exam_date', endDate);

        // 2. Tarik Data Kehadiran
        const { data: attData } = await supabase
            .from('attendance')
            .select('*')
            .eq('tenant_id', tenant_id)
            .gte('exam_date', startDate)
            .lte('exam_date', endDate);

        // 3. Tarik Data Kutipan Skrip
        const { data: colData } = await supabase
            .from('collection')
            .select('*')
            .eq('tenant_id', tenant_id)
            .gte('collection_date', startDate)
            .lte('collection_date', endDate);

        // --- PROSES DATA & PENAPISAN ---
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        
        let totalCheckIn = 0, onTime = 0, gpOnTime = 0, late = 0;
        let totalCheckOut = 0, returnedScripts = 0, pendingCheckOut = 0;
        let collectionCount = colData ? colData.length : 0;

        const listTotal = [], listOnTime = [], listGP = [], listLate = [];
        const listTotalOut = [], listReturned = [], listPending = [], listCollection = [];
        
        const absentListMap = new Map();
        const staffPhoneMap = new Map();

        // A. Peta Jadual & Kenal pasti Absent
        if (schData) {
            schData.forEach(r => {
                const sId = String(r.staff_id).toLowerCase();
                if (r.contact_number) staffPhoneMap.set(sId, r.contact_number);
                
                const key = `${r.exam_date}|${r.exam_session}|${sId}`;
                if (!absentListMap.has(key)) {
                    const d = new Date(r.exam_date);
                    absentListMap.set(key, {
                        date: r.exam_date, day: dayNames[d.getDay()], venue: r.venue,
                        session: r.exam_session, id: r.staff_id, name: r.staff_name,
                        phone: r.contact_number || 'N/A'
                    });
                }
            });
        }

        // B. Proses Kehadiran
        if (attData) {
            attData.forEach(r => {
                const sIdLower = String(r.staff_id).toLowerCase();
                const key = `${r.exam_date}|${r.exam_session}|${sIdLower}`;
                
                // Buang dari senarai absent kerana staf ini telah hadir
                absentListMap.delete(key);

                const d = new Date(r.exam_date);
                const recordObj = {
                    date: r.exam_date, day: dayNames[d.getDay()], venue: r.venue,
                    session: r.exam_session, id: r.staff_id, name: r.staff_name,
                    status: r.status, checkInTime: r.check_in_time, checkOutTime: r.check_out_time,
                    returned: r.returned_script, cCodes: r.course_code, cDescs: r.course_desc,
                    phone: staffPhoneMap.get(sIdLower) || 'N/A'
                };

                listTotal.push(recordObj);
                totalCheckIn++;

                if (r.status === 'On-Time') { listOnTime.push(recordObj); onTime++; }
                else if (r.status === 'GP: On-Time') { listGP.push(recordObj); gpOnTime++; }
                else if (r.status === 'Late') { listLate.push(recordObj); late++; }

                if (r.check_out_time) { listTotalOut.push(recordObj); totalCheckOut++; }
                else { listPending.push(recordObj); pendingCheckOut++; }

                if (r.returned_script === 'Yes') { listReturned.push(recordObj); returnedScripts++; }
            });
        }

        // C. Proses Collection
        if (colData) {
            colData.forEach(r => {
                const d = new Date(r.collection_date);
                listCollection.push({
                    date: r.collection_date, day: dayNames[d.getDay()], venue: r.venue,
                    role: r.rep_name ? 'Representative' : 'Self', id: r.staff_id,
                    name: r.staff_name, phone: r.contact_no, cCode: r.course_code,
                    cName: r.course_name, qty: r.quantity, remarks: r.remarks
                });
            });
        }

        const absentList = Array.from(absentListMap.values());

        // D. Pulangkan ringkasan ke Frontend
        res.status(200).json({
            success: true,
            counts: { 
                totalCheckIn, onTime, gpOnTime, late, totalCheckOut, 
                returnedScripts, pendingCheckOut, totalAbsent: absentList.length, collectionCount 
            },
            lists: { 
                total: listTotal, onTime: listOnTime, gpOnTime: listGP, late: listLate, 
                totalOut: listTotalOut, returned: listReturned, pending: listPending, 
                absent: absentList, collection: listCollection 
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 13: Muat Naik Jadual Tugas (Modul Admin) - VERSI KEBAL + CHUNKING TEPAT
// =====================================================
app.post('/api/admin/upload-schedule', upload.single('excelFile'), async (req, res) => {
    try {
        const tenant_id = req.body.tenant_id;
        if (!req.file) return res.status(400).json({ success: false, message: 'Sila muat naik fail Excel.' });
        if (!tenant_id) return res.status(400).json({ success: false, message: 'Tenant ID diperlukan.' });

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; 
        const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });

        if (rawData.length === 0) throw new Error("Fail Excel kosong.");

        const formatExcelDate = (excelDate) => {
            if (!excelDate) return null;
            if (typeof excelDate === 'number') {
                const date = new Date(Math.round((excelDate - 25569) * 86400 * 1000));
                return date.toISOString().split('T')[0];
            }
            return String(excelDate);
        };

        const formatExcelTime = (excelTime) => {
            if (!excelTime || excelTime === '####') return null;
            if (typeof excelTime === 'number') {
                let totalSeconds = Math.round(excelTime * 86400);
                let hours = Math.floor(totalSeconds / 3600);
                let minutes = Math.floor((totalSeconds % 3600) / 60);
                let seconds = totalSeconds % 60;
                return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            }
            const strTime = String(excelTime).trim();
            if (/^\d{1,2}:\d{2}/.test(strTime)) {
                return strTime;
            }
            return null;
        };

        const getVal = (row, possibleKeys) => {
            const rowKeys = Object.keys(row);
            for (let key of rowKeys) {
                const cleanKey = key.trim().toLowerCase().replace(/\s+/g, ' '); 
                for (let pKey of possibleKeys) {
                    if (cleanKey === pKey.toLowerCase()) {
                        return row[key] !== null ? row[key] : null;
                    }
                }
            }
            return null;
        };

        // 2. Formatkan data Excel (DISUSUN MENGIKUT NAMA LAJUR SUPABASE ANDA)
        const formattedData = rawData.map(row => ({
            tenant_id: tenant_id,
            exam_date: formatExcelDate(getVal(row, ['date', 'exam date', 'tarikh'])), 
            exam_session: getVal(row, ['session', 'sesi', 'exam session']),
            campus: getVal(row, ['campus', 'kampus']),
            venue: getVal(row, ['venue', 'dewan', 'lokasi']),
            course_code: getVal(row, ['course code', 'subject code', 'kod kursus', 'kod subjek', 'Course']),
            course_desc: getVal(row, ['course name', 'course description', 'Course Description', 'subject name', 'nama kursus']), // <--- DITUKAR KEPADA course_desc
            start_time: formatExcelTime(getVal(row, ['start time', 'masa mula', 'time start', 'Start Time'])),
            end_time: formatExcelTime(getVal(row, ['end time', 'masa tamat', 'time end', 'Time To'])),
            start_seat: String(getVal(row, ['start seat', 'mula tempat duduk', 'seat start', 'Seating From']) || ''), // <--- DITAMBAH
            end_seat: String(getVal(row, ['end seat', 'tamat tempat duduk', 'seat end', 'Seating To']) || ''), // <--- DITAMBAH
            total_student: String(getVal(row, ['total student', 'jumlah pelajar', 'total students', 'Total Student']) || ''), // <--- DITAMBAH
            staff_id: String(getVal(row, ['staff id', 'id staf', 'id pengawas', 'Staff ID']) || ''),
            staff_name: getVal(row, ['name', 'staff name', 'nama', 'nama staf', 'nama pengawas', 'Name']), // <--- DITUKAR KEPADA staff_name
            role: getVal(row, ['role', 'peranan', 'jawatan', 'Role']),
            contact_number: String(getVal(row, ['phone', 'contact number', 'no tel', 'no telefon', 'Contact Number']) || '') // <--- DITUKAR KEPADA contact_number
        }));

        // 3. Masukkan data ke dalam pangkalan data (Teknik Chunking 500 baris)
        const chunkSize = 500;
        for (let i = 0; i < formattedData.length; i += chunkSize) {
            const chunk = formattedData.slice(i, i + chunkSize);
            const { error } = await supabase.from('duty_schedule').insert(chunk);
            if (error) {
                console.error("Ralat Chunking Supabase:", error);
                throw new Error("Gagal menyimpan sebahagian data ke Supabase.");
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: `${formattedData.length} baris rekod jadual berjaya dimuat naik secara berperingkat!` 
        });

    } catch (err) {
        console.error("Ralat Muat Naik:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
// =====================================================
// API 14: Log Masuk Admin (Sistem Multi-Tenant Database)
// =====================================================
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Sistem kini menyemak ID dan Kata Laluan terus dari Supabase!
        const { data, error } = await supabase
            .from('tenants')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (error || !data) {
            return res.status(401).json({ success: false, message: 'ID Pengguna atau Kata Laluan salah!' });
        }

        res.status(200).json({ 
            success: true, 
            token: 'kunci-rahsia-exact-2026',
            tenant_id: data.id,
            uni_name: data.tenant_name
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// =====================================================
// API 15: Tambah Semester Baharu (Modul Admin)
// =====================================================
app.post('/api/admin/semester', async (req, res) => {
    try {
        const { tenant_id, name, start_date, end_date } = req.body;
        if (!tenant_id || !name || !start_date || !end_date) {
            return res.status(400).json({ success: false, message: 'Maklumat tidak lengkap.' });
        }

        const { error } = await supabase.from('semesters').insert([{ tenant_id, name, start_date, end_date }]);
        if (error) throw error;

        res.status(200).json({ success: true, message: 'Semester baharu berjaya ditambah!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 16: Tambah Konfigurasi Lokasi & Sesi (Modul Admin)
// =====================================================
app.post('/api/admin/config', async (req, res) => {
    try {
        const { tenant_id, campus, venue, exam_session, start_time } = req.body;
        if (!tenant_id || !campus || !venue || !exam_session) {
            return res.status(400).json({ success: false, message: 'Maklumat kampus, dewan, dan sesi wajib diisi.' });
        }

        const { error } = await supabase.from('config').insert([{ tenant_id, campus, venue, exam_session, start_time }]);
        if (error) throw error;

        res.status(200).json({ success: true, message: 'Tetapan lokasi/sesi berjaya ditambah!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 17 & 18: Baca & Padam Semester (Admin)
// =====================================================
app.get('/api/admin/semesters/:tenant_id', async (req, res) => {
    const { data, error } = await supabase.from('semesters').select('*').eq('tenant_id', req.params.tenant_id).order('start_date', { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(200).json({ success: true, data });
});

app.delete('/api/admin/semester/:id', async (req, res) => {
    const { error } = await supabase.from('semesters').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(200).json({ success: true });
});

// =====================================================
// API 19 & 20: Baca & Padam Lokasi/Sesi (Admin)
// =====================================================
app.get('/api/admin/configs/:tenant_id', async (req, res) => {
    const { data, error } = await supabase.from('config').select('*').eq('tenant_id', req.params.tenant_id).order('campus').order('venue');
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(200).json({ success: true, data });
});

app.delete('/api/admin/config/:id', async (req, res) => {
    const { error } = await supabase.from('config').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(200).json({ success: true });
});

// =====================================================
// API 21: Kemaskini Semester (Admin)
// =====================================================
app.put('/api/admin/semester/:id', async (req, res) => {
    const { name, start_date, end_date } = req.body;
    const { error } = await supabase.from('semesters')
        .update({ name, start_date, end_date })
        .eq('id', req.params.id);
        
    if (error) return res.status(400).json({ success: false, message: error.message });
    res.status(200).json({ success: true, message: 'Semester berjaya dikemas kini!' });
});

// =====================================================
// API 22: Tambah Lokasi & Sesi Baru (+ Passcode)
// =====================================================
app.post('/api/admin/config', async (req, res) => {
    try {
        const { tenant_id, campus, venue, exam_session, start_time, passcode } = req.body;
        const { data, error } = await supabase
            .from('config') // <--- DIBETULKAN
            .insert([{ tenant_id, campus, venue, exam_session, start_time, passcode }]);
        
        if (error) throw error;
        res.status(201).json({ success: true, message: 'Lokasi & Sesi berjaya ditambah.', data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 23: Kemas Kini Lokasi & Sesi (+ Passcode)
// =====================================================
app.put('/api/admin/config/:id', async (req, res) => {
    try {
        const configId = req.params.id;
        const { campus, venue, exam_session, start_time, passcode } = req.body;
        const { data, error } = await supabase
            .from('config') // <--- DIBETULKAN
            .update({ campus, venue, exam_session, start_time, passcode })
            .eq('id', configId);

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Lokasi & Sesi dikemas kini.', data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// =====================================================
// API 24: Log Masuk Super-Admin
// =====================================================
app.post('/api/superadmin/login', (req, res) => {
    const { username, password } = req.body;
    
    // ID dan Kata Laluan Rahsia untuk Anda (Founder)
    const SUPER_USER = 'founder';
    const SUPER_PASS = 'exact2026';

    if (username === SUPER_USER && password === SUPER_PASS) {
        res.status(200).json({ 
            success: true, 
            token: 'kunci-super-exact-2026'
        });
    } else {
        res.status(401).json({ success: false, message: 'ID Pengguna atau Kata Laluan Super-Admin salah!' });
    }
});
// =====================================================
// API 25: Baca Senarai Universiti (Untuk Super-Admin)
// =====================================================
app.get('/api/superadmin/tenants', async (req, res) => {
    try {
        // Tarik data ID, Nama Universiti dan Username sahaja dari Supabase
        const { data, error } = await supabase
            .from('tenants')
            .select('id, tenant_name, username')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.status(200).json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 26: Baca Semua Jadual (Untuk Tab 4: Urus Jadual)
// =====================================================
app.get('/api/admin/schedules/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { data, error } = await supabase
            .from('duty_schedule')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('exam_date', { ascending: false }) // <--- Tukar dari date ke exam_date
            .limit(10000); 

        if (error) throw error;
        res.status(200).json({ success: true, data });
    } catch (err) {
        console.log("Ralat Tarik Data Supabase:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 27: Kemas Kini Jadual Spesifik (Ad-Hoc)
// =====================================================
app.put('/api/admin/schedule/:id', async (req, res) => {
    try {
        const scheduleId = req.params.id;
        // Gunakan nama lajur yang betul!
        const { staff_id, staff_name, role, contact_number, venue, exam_session } = req.body;

        const { data, error } = await supabase
            .from('duty_schedule')
            .update({ 
                staff_id: staff_id, 
                staff_name: staff_name, 
                role: role, 
                contact_number: contact_number,
                venue: venue,
                exam_session: exam_session
            })
            .eq('id', scheduleId)
            .select();

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Jadual petugas berjaya dikemas kini.', data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// =====================================================
// API 28: Hantar Tiket Sokongan (Dengan Upload Fail)
// =====================================================
// Kita gunakan upload.single('attachment') untuk menangkap fail
app.post('/api/admin/support', upload.single('attachment'), async (req, res) => {
    try {
        const { tenant_id, tenant_name, category, message } = req.body; 
        let attachment_url = null;
        
        if (!tenant_id || !category || !message) {
            return res.status(400).json({ success: false, message: 'Sila lengkapkan maklumat kategori dan mesej.' });
        }

        // --- PROSES UPLOAD FAIL KE SUPABASE STORAGE (JIKA ADA FAIL) ---
        if (req.file) {
            const fileExt = path.extname(req.file.originalname);
            // Hasilkan nama fail unik (Cth: 16900000-12345.png)
            const fileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${fileExt}`;
            const filePath = `tickets/${tenant_id}/${fileName}`;

            // Muat naik ke tong 'support_attachments'
            const { data: uploadData, error: uploadError } = await supabase
                .storage
                .from('support_attachments')
                .upload(filePath, req.file.buffer, {
                    contentType: req.file.mimetype
                });

            if (uploadError) throw uploadError;

            // Dapatkan pautan awam (Public URL) fail tersebut
            const { data: publicUrlData } = supabase
                .storage
                .from('support_attachments')
                .getPublicUrl(filePath);

            attachment_url = publicUrlData.publicUrl;
        }

        // --- MASUKKAN DATA KE DALAM JADUAL ---
        const { error } = await supabase
            .from('support_tickets')
            .insert([{ 
                tenant_id, 
                tenant_name, 
                category, 
                message, 
                attachment_url, // Masukkan URL fail
                status: 'Open' 
            }]); 

        if (error) throw error;
        
        res.status(200).json({ success: true, message: 'Mesej & lampiran anda telah berjaya dihantar kepada Super-Admin!' });
    } catch (err) {
        console.error("Ralat Upload Support:", err.message);
        res.status(500).json({ success: false, message: "Ralat: " + err.message });
    }
});
// =====================================================
// API 29: Tarik Semua Tiket Sokongan (Super-Admin)
// =====================================================
app.get('/api/superadmin/tickets', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('support_tickets')
            .select('*')
            // Susun tiket dari yang paling baharu
            .order('created_at', { ascending: false }); 

        if (error) throw error;
        res.status(200).json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 30: Tukar Status Tiket (Super-Admin)
// =====================================================
app.put('/api/superadmin/ticket/:id', async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { status } = req.body;
        
        const { error } = await supabase
            .from('support_tickets')
            .update({ status: status })
            .eq('id', ticketId);

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Status tiket berjaya dikemas kini!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 31: Baca Info Universiti & Tema Penuh (Untuk Skrin Live)
// =====================================================
app.get('/api/tenant-info/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('tenants')
            // Kita tarik semua lajur penjenamaan baharu
            .select('tenant_name, theme_color, logo_url, theme_mode, color_header, color_button, color_text')
            .eq('id', req.params.id)
            .single();

        if (error) throw error;
        res.status(200).json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 32: Kemas Kini Mod Tema Lanjutan (Dari Portal Admin)
// =====================================================
app.put('/api/admin/advanced-theme', async (req, res) => {
    try {
        const { tenant_id, theme_mode, color_header, color_button, color_text } = req.body;
        const { error } = await supabase
            .from('tenants')
            .update({ theme_mode, color_header, color_button, color_text })
            .eq('id', tenant_id);

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Tetapan tema berjaya disimpan!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =====================================================
// API 33: Muat Naik Logo Universiti & Ekstrak Auto-URL
// =====================================================
app.post('/api/admin/upload-logo', upload.single('logo'), async (req, res) => {
    try {
        const tenant_id = req.body.tenant_id;
        if (!req.file || !tenant_id) return res.status(400).json({ success: false, message: 'Sila pilih fail logo.' });

        const fileExt = path.extname(req.file.originalname);
        const fileName = `logo_${tenant_id}_${Date.now()}${fileExt}`;
        const filePath = `${tenant_id}/${fileName}`;

        // 1. Muat naik logo ke tong 'tenant_logos'
        const { error: uploadError } = await supabase
            .storage
            .from('tenant_logos')
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (uploadError) throw uploadError;

        // 2. Dapatkan pautan awam (Public URL)
        const { data: publicUrlData } = supabase.storage.from('tenant_logos').getPublicUrl(filePath);
        const logo_url = publicUrlData.publicUrl;

        // 3. Simpan URL logo tersebut ke dalam jadual tenants
        const { error: dbError } = await supabase
            .from('tenants')
            .update({ logo_url: logo_url })
            .eq('id', tenant_id);

        if (dbError) throw dbError;

        res.status(200).json({ success: true, message: 'Logo berjaya dimuat naik!', logo_url });
    } catch (err) {
        console.error("Ralat Upload Logo:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Hidupkan Pelayan
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Pelayan EXACT Backend sedang berjalan di port ${PORT}`);
});