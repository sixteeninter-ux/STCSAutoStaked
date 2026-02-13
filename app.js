(() => {
  "use strict";

  const C = window.APP_CONFIG;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = String(t ?? "-"); };
  const setStatus = (t) => { const el = $("status"); if (el) el.textContent = String(t ?? "-"); };

  const shortAddr = (a) => a ? (a.slice(0, 6) + "..." + a.slice(-4)) : "-";
  const fmtDate = (sec) => {
    try { return new Date(Number(sec) * 1000).toLocaleString(); } catch { return "-"; }
  };
  const fmtDur = (sec) => {
    sec = Number(sec);
    if (!isFinite(sec) || sec <= 0) return "00:00:00";
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const h = Math.floor(sec / 3600);  sec -= h * 3600;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    const pad = (n) => String(n).padStart(2, "0");
    return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`;
  };

  // ---------- ABIs ----------
  const ERC20_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
    "function decimals() view returns(uint8)",
    "function symbol() view returns(string)"
  ];

  const STAKING_ABI = [
    "function owner() view returns(address)",
    "function stcPerStcex() view returns(uint256)",
    "function minStakeSTCEx() view returns(uint256)",
    "function lockSeconds() view returns(uint256)",
    "function periodSeconds() view returns(uint256)",
    "function rewardBps() view returns(uint256)",
    "function positionsCount(address) view returns(uint256)",
    "function getPosition(address,uint256) view returns(uint256 principalSTC,uint256 startTime,bool withdrawn)",
    "function unlockAt(address,uint256) view returns(uint256)",
    "function timeUntilUnlock(address,uint256) view returns(uint256)",
    "function accruedRewardSTC(address,uint256) view returns(uint256 reward,uint256 periods)",
    "function matured(address,uint256) view returns(bool)",
    "function stakeWithSTCEx(uint256) external",
    "function withdrawPosition(uint256) external",
  ];

  // ---------- State ----------
  let provider, signer, user;
  let staking, stcex, stc;
  let stcexDec = 18, stcDec = 18;

  let timer = null;

  // ---------- Chain helpers ----------
  async function ensureBSC() {
    try {
      const hex = C.CHAIN_ID_HEX || "0x38";
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      });
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      if (e?.code === 4902 || msg.includes("4902")) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: C.CHAIN_ID_HEX || "0x38",
              chainName: C.CHAIN_NAME || "BSC Mainnet",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: [C.RPC_URL || "https://bsc-dataseed.binance.org/"],
              blockExplorerUrls: [C.EXPLORER || "https://bscscan.com"],
            }]
          });
          return true;
        } catch {
          throw new Error("เพิ่มเครือข่าย BSC ไม่สำเร็จ (Bitget/MetaMask)");
        }
      }
      throw new Error("กรุณาสลับเครือข่ายเป็น BSC (56) ก่อนทำรายการ");
    }
  }

  function parseInputAmount(id, dec) {
    const v = (($(id)?.value || "") + "").trim().replace(/,/g, "");
    if (!v) throw new Error("กรุณากรอกจำนวน");
    return ethers.parseUnits(v, dec);
  }

  // ---------- Connect ----------
  async function connect() {
    try {
      if (!window.ethereum) throw new Error("ไม่พบกระเป๋า (MetaMask/Bitget)");

      provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      await ensureBSC();

      signer = await provider.getSigner();
      user = await signer.getAddress();

      setText("wallet", shortAddr(user));
      setText("contract", C.CONTRACT);

      const explorer = C.EXPLORER || "https://bscscan.com";
      const linkC = $("linkContract");
      const linkW = $("linkWallet");
      if (linkC) linkC.href = `${explorer}/address/${C.CONTRACT}`;
      if (linkW) linkW.href = `${explorer}/address/${user}`;

      staking = new ethers.Contract(C.CONTRACT, STAKING_ABI, signer);
      stcex   = new ethers.Contract(C.STCEX, ERC20_ABI, signer);
      stc     = new ethers.Contract(C.STC,   ERC20_ABI, signer);

      try { stcexDec = Number(await stcex.decimals()); } catch {}
      try { stcDec   = Number(await stc.decimals()); } catch {}

      // ซ่อน owner box ฝั่ง user
      const ownerBox = $("ownerBox");
      if (ownerBox) ownerBox.style.display = "none";
      try {
        await staking.owner();
      } catch {}

      // enable buttons
      const bR = $("btnRefresh");
      const bA = $("btnApprove");
      const bS = $("btnStake");
      if (bR) bR.disabled = false;
      if (bA) bA.disabled = false;
      if (bS) bS.disabled = false;

      setStatus("✅ เชื่อมต่อสำเร็จ (BSC)");

      await refreshAll();

      if (timer) clearInterval(timer);
      timer = setInterval(updateCountdownCells, 1000);

    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.message || e}`);
    }
  }

  // ---------- Refresh ----------
  async function refreshBalances() {
    if (!user) return;
    const [b1, b2, alw] = await Promise.all([
      stcex.balanceOf(user),
      stc.balanceOf(user),
      stcex.allowance(user, C.CONTRACT),
    ]);
    setText("balSTCEx", ethers.formatUnits(b1, stcexDec));
    setText("balSTC",   ethers.formatUnits(b2, stcDec));
    setText("allowSTCEx", ethers.formatUnits(alw, stcexDec));
  }

  async function refreshPositions() {
    if (!user) return;

    const count = Number(await staking.positionsCount(user));
    setText("posCount", count);

    const tbody = $("posTbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (count === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="muted">ยังไม่มี position</td></tr>`;
      return;
    }

    for (let posId = 0; posId < count; posId++) {
      const [pos, unlockAt, ar, matured] = await Promise.all([
        staking.getPosition(user, posId),
        staking.unlockAt(user, posId),
        staking.accruedRewardSTC(user, posId),
        staking.matured(user, posId),
      ]);

      const principal = pos.principalSTC;
      const startTime = pos.startTime;
      const withdrawn = pos.withdrawn;

      const reward = ar.reward;
      const periods = ar.periods;

      const now = Math.floor(Date.now() / 1000);
      const unlock = Number(unlockAt);
      const left = Math.max(0, unlock - now);

      const statusText = withdrawn ? "WITHDRAWN" : (matured ? "MATURED" : "LOCKED");
      const statusClass = withdrawn ? "no" : (matured ? "ok" : "warn");

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${posId}</td>
        <td class="mono">${ethers.formatUnits(principal, stcDec)}</td>
        <td class="mono">${fmtDate(startTime)}</td>
        <td class="mono">${fmtDate(unlockAt)}</td>

        <!-- ✅ สำคัญ: เก็บ unlockAt ไว้ แล้วคำนวณจากเวลาจริงทุกวินาที -->
        <td class="mono"
            data-posid="${posId}"
            data-col="countdown"
            data-unlock="${unlock}">
          ${fmtDur(left)}
        </td>

        <td class="mono">${periods.toString()}</td>
        <td class="mono">${ethers.formatUnits(reward, stcDec)}</td>
        <td class="${statusClass}" data-posid="${posId}" data-col="status">${statusText}</td>
        <td>
          <button class="smallbtn" data-posid="${posId}" data-col="withdrawbtn" ${(!matured || withdrawn) ? "disabled" : ""}>
            Withdraw
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(`button[data-col="withdrawbtn"]`).forEach(btn => {
      btn.addEventListener("click", async () => {
        const posId = Number(btn.dataset.posid);
        await withdrawPosition(posId);
      });
    });
  }

  // ✅ นับถอยหลังแบบ real-time (แก้ปัญหามือถือ Bitget/MetaMask ที่ setInterval หน่วง)
  function updateCountdownCells() {
    const now = Math.floor(Date.now() / 1000);
    const cells = document.querySelectorAll(`[data-col="countdown"][data-posid]`);

    for (const el of cells) {
      const unlock = Number(el.dataset.unlock || 0);
      const left = Math.max(0, unlock - now);
      el.textContent = fmtDur(left);

      const posId = el.dataset.posid;

      const st = document.querySelector(`[data-posid="${posId}"][data-col="status"]`);
      if (st && left === 0 && st.textContent === "LOCKED") {
        st.textContent = "MATURED";
        st.className = "ok";
      }

      const btn = document.querySelector(`[data-posid="${posId}"][data-col="withdrawbtn"]`);
      if (btn) btn.disabled = (left !== 0);
    }
  }

  async function refreshAll() {
    try {
      const bR = $("btnRefresh");
      if (bR) bR.disabled = true;

      await refreshBalances();
      await refreshPositions();

      if (bR) bR.disabled = false;
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.message || e}`);
      const bR = $("btnRefresh");
      if (bR) bR.disabled = false;
    }
  }

  // ---------- Actions ----------
  async function approveSTCEx() {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      const bA = $("btnApprove");
      if (bA) bA.disabled = true;

      setStatus("⏳ กำลังขออนุมัติ (Approve) STCEx...");

      const tx = await stcex.approve(C.CONTRACT, ethers.MaxUint256);
      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยันในกระเป๋า...");
      await tx.wait();

      setStatus("✅ Approve สำเร็จ");
      await refreshBalances();

      if (bA) bA.disabled = false;
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
      const bA = $("btnApprove");
      if (bA) bA.disabled = false;
    }
  }

  async function stake() {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      const amt = parseInputAmount("inStake", stcexDec);

      const bS = $("btnStake");
      if (bS) bS.disabled = true;

      setStatus("⏳ กำลัง Stake ด้วย STCEx...");

      const tx = await staking.stakeWithSTCEx(amt);
      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยัน...");
      await tx.wait();

      setStatus("✅ Stake สำเร็จ");
      await refreshAll();

      if (bS) bS.disabled = false;
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
      const bS = $("btnStake");
      if (bS) bS.disabled = false;
    }
  }

  async function withdrawPosition(posId) {
    try {
      if (!user) throw new Error("กรุณาเชื่อมต่อกระเป๋าก่อน");
      await ensureBSC();

      setStatus(`⏳ กำลังถอน posId #${posId}...`);

      const tx = await staking.withdrawPosition(posId);
      setStatus("⏳ ส่งธุรกรรมแล้ว รอยืนยัน...");
      await tx.wait();

      setStatus(`✅ ถอน posId #${posId} สำเร็จ`);
      await refreshAll();
    } catch (e) {
      console.error(e);
      setStatus(`❌ ${e?.shortMessage || e?.message || e}`);
    }
  }

  // ---------- Bind UI ----------
  function bind() {
    $("btnConnect")?.addEventListener("click", connect);
    $("btnRefresh")?.addEventListener("click", refreshAll);
    $("btnApprove")?.addEventListener("click", approveSTCEx);
    $("btnStake")?.addEventListener("click", stake);
  }

  bind();

  // ✅ มือถือชอบ pause JS ตอนสลับแอพ/ล็อคจอ -> กลับมาให้รีเฟรชทันที
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshAll().catch(() => {});
    }
  });
})();
