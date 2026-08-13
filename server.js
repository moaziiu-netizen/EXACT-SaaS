require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
    const { tenant_id, staff_id } = req.params;
    
    // Dapatkan tarikh hari ini
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }); 
    
    const { data, error } = await supabase
        .from('duty_schedule')
        .select('*')
        .eq('tenant_id', tenant_id)
        .eq('staff_id', staff_id)
        //.eq('exam_date', today);

    if (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    
    if (!data || data.length === 0) {
        return res.status(404).json({ success: false, message: `ID Staf ${staff_id} tidak ditemui dalam jadual hari ini.` });
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
});

// =====================================================
// API 3: Check-In Bersepadu (Logik Masa & Anti-Spam)
// =====================================================
app.post('/api/checkin', async (req, res) => {
    const { tenant_id, staffId, name, role, campus, venue, session, remarks } = req.body;

    try {
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
// API 5: Tarik Master Schedule (Home Table)
// =====================================================
app.post('/api/master-schedule', async (req, res) => {
    const { tenant_id, date, campus, venue, session, q } = req.body;

    // Bina arahan carian Supabase
    let query = supabase.from('duty_schedule').select('*').eq('tenant_id', tenant_id);

    // Tambah penapis jika pengguna memilihnya di antaramuka
    if (date) query = query.eq('exam_date', date);
    if (campus) query = query.eq('campus', campus);
    if (venue) query = query.eq('venue', venue);
    if (session) query = query.eq('exam_session', session);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    // Kumpulkan kursus jika staf mengawas lebih dari 1 kertas (Sama seperti logik Google Script lama)
    const grouped = new Map();
    data.forEach(r => {
        // Carian teks bebas (Name / ID / Course)
        if (q) {
            const hay = [r.course_code, r.course_desc, r.staff_id, r.staff_name].join(' ').toLowerCase();
            if (!hay.includes(q.toLowerCase())) return; 
        }

        const key = `${r.exam_date}||${r.campus}||${r.exam_session}||${r.venue}||${r.staff_id}||${r.staff_name}||${r.role}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                dateIso: r.exam_date, campus: r.campus, session: r.exam_session,
                venue: r.venue, id: r.staff_id, name: r.staff_name, post: r.role,
                courses: new Map(), courseObjects: []
            });
        }

        if (r.course_code) {
            // Buang saat dari format masa SQL (cth: 09:00:00 -> 09:00)
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

// Hidupkan Pelayan
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Pelayan EXACT Backend sedang berjalan di port ${PORT}`);
});