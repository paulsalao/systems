// Admin control panel
(function () {
  const UNITS = ['Unit 101', 'Unit 102', 'Unit 103', 'Unit 104', 'Deluxe Unit 201', 'Deluxe Unit 202'];
  let bookings = [];

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The server request failed.');
    return result;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  function formatTime(time) {
    const [hour, minute] = time.split(':').map(Number);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
  }

  async function loadBookings() {
    const result = await apiRequest('/api/admin/bookings');
    bookings = result.bookings;
    renderAdminPanel();
  }

  function renderAdminPanel() {
    const container = document.getElementById('adminContainer');
    if (!container) return;
    let html = '';
    UNITS.forEach(unit => {
      const unitBookings = bookings.filter(booking => booking.unit === unit);
      html += '<div class="admin-unit">';
      html += '<h3>' + escapeHtml(unit) + '</h3>';
      html += '<span class="status ' + (unitBookings.length ? 'booked' : 'available') + '">' + (unitBookings.length ? 'BOOKED' : 'AVAILABLE') + '</span>';
      if (unitBookings.length) {
        html += '<ul class="booking-list">';
        unitBookings.forEach(booking => {
          const customerInfo = booking.customer
            ? ' - ' + escapeHtml(booking.customer) + ' (' + escapeHtml(booking.category) + ')'
            : ' - Unavailable';
          html += '<li class="booking-item"><span>' + formatTime(booking.start) + ' - ' + formatTime(booking.end) + customerInfo + '</span></li>';
        });
        html += '</ul>';
      } else {
        html += '<p class="empty">No bookings. Unit is fully available.</p>';
        html += '<div class="add-booking"><input type="time" class="add-start" placeholder="Start"><input type="time" class="add-end" placeholder="End"><button class="add-btn" data-unit="' + escapeHtml(unit) + '">Add Booking</button></div>';
      }
      html += '</div>';
    });
    container.innerHTML = html;

    document.querySelectorAll('.add-btn').forEach(button => {
      button.addEventListener('click', async function () {
        const row = this.closest('.add-booking');
        const start = row.querySelector('.add-start').value;
        const end = row.querySelector('.add-end').value;
        if (!start || !end) {
          alert('Please enter both start and end times.');
          return;
        }
        try {
          await apiRequest('/api/admin/blocks', {
            method: 'POST',
            body: JSON.stringify({ unit: this.dataset.unit, start, end })
          });
          await loadBookings();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  async function renderRecords() {
    const tbody = document.querySelector('#recordsTable tbody');
    if (!tbody) return;
    try {
      const result = await apiRequest('/api/admin/records');
      if (!result.records.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;">No customer booking records found.</td></tr>';
        return;
      }
      tbody.innerHTML = result.records.map(booking => `
        <tr>
          <td>${escapeHtml(booking.bookingDate)}</td>
          <td>${escapeHtml(booking.unit)}</td>
          <td>${escapeHtml(booking.customer)}</td>
          <td>${escapeHtml(booking.category)}</td>
          <td>${formatTime(booking.start)} - ${formatTime(booking.end)}</td>
          <td>${escapeHtml(booking.durationMinutes)} min</td>
          <td>₱${escapeHtml(booking.price)}</td>
        </tr>
      `).join('');
    } catch (error) {
      alert(error.message);
    }
  }

  function showAdminPanel() {
    document.getElementById('passwordOverlay').style.display = 'none';
    loadBookings().catch(error => {
      alert(error.message);
      document.getElementById('passwordOverlay').style.display = 'grid';
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    const unitSelectOverlay = document.getElementById('unitSelectOverlay');
    const unitSelectReset = document.getElementById('unitSelectReset');
    const unitSelectError = document.getElementById('unitSelectError');

    document.getElementById('resetAllBtn').addEventListener('click', function () {
      unitSelectReset.innerHTML = '';
      UNITS.forEach(unit => {
        const option = document.createElement('option');
        option.value = unit;
        option.textContent = unit;
        unitSelectReset.appendChild(option);
      });
      unitSelectError.textContent = '';
      unitSelectOverlay.style.display = 'grid';
    });

    document.getElementById('unitSelectConfirm').addEventListener('click', async function () {
      const unit = unitSelectReset.value;
      if (!unit) {
        unitSelectError.textContent = 'Please select a unit.';
        return;
      }
      try {
        await apiRequest('/api/admin/units/' + encodeURIComponent(unit) + '/bookings', { method: 'DELETE' });
        unitSelectOverlay.style.display = 'none';
        await loadBookings();
      } catch (error) {
        unitSelectError.textContent = error.message;
      }
    });
    document.getElementById('unitSelectCancel').addEventListener('click', () => {
      unitSelectOverlay.style.display = 'none';
    });

    document.getElementById('recordsBtn').addEventListener('click', async function () {
      await renderRecords();
      document.getElementById('recordsOverlay').style.display = 'grid';
    });
    document.getElementById('recordsClose').addEventListener('click', function () {
      document.getElementById('recordsOverlay').style.display = 'none';
    });
    document.getElementById('recordsPrint').addEventListener('click', function () {
      window.print();
    });
    document.getElementById('adminLogoutBtn').addEventListener('click', async function () {
      try {
        await apiRequest('/api/admin/logout', { method: 'POST' });
        window.location.href = 'index.html';
      } catch (error) {
        alert(error.message);
      }
    });

    const overlay = document.getElementById('passwordOverlay');
    const passwordInput = document.getElementById('adminPassword');
    const errorEl = document.getElementById('passwordError');
    const login = async function () {
      try {
        await apiRequest('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ password: passwordInput.value })
        });
        passwordInput.value = '';
        showAdminPanel();
      } catch (error) {
        errorEl.textContent = error.message;
        passwordInput.value = '';
        passwordInput.focus();
      }
    };

    document.getElementById('passwordConfirm').addEventListener('click', login);
    document.getElementById('passwordCancel').addEventListener('click', function () {
      window.location.href = 'index.html';
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && overlay.style.display !== 'none') login();
      if (event.key === 'Escape' && overlay.style.display !== 'none') window.location.href = 'index.html';
    });

    try {
      const sessionState = await apiRequest('/api/admin/session');
      if (sessionState.authenticated) {
        showAdminPanel();
      } else {
        overlay.style.display = 'grid';
        passwordInput.focus();
      }
    } catch (error) {
      errorEl.textContent = error.message;
      overlay.style.display = 'grid';
    }
  });
})();
