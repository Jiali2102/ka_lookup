import json
import os
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import csv
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ghn_checker_config.json")

COLOR_ORANGE = "#FE5F00"
COLOR_ORANGE_DARK = "#E0500A"
COLOR_BLUE = "#0E4174"
COLOR_BG = "#F7F6F3"
COLOR_SURFACE = "#FFFFFF"
COLOR_BORDER = "#EAE6DE"
COLOR_TEXT = "#22201C"
COLOR_MUTED = "#8B857A"
COLOR_OK = "#1E8E5A"
COLOR_OK_BG = "#E9F7EF"
COLOR_DANGER = "#C0392B"
COLOR_DANGER_BG = "#FBEAE8"

FONT_FAMILY = "Cambria"

TRACKING_URL = "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/tracking-logs"
HO_CHI_MINH_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

DELIVERED = "Giao hàng thành công"
LOST_STATUSES = ["Hàng thất lạc", "Hàng hư hỏng", "Huỷ đơn hàng"]

REQUEST_SLEEP_SECONDS = 1.5
MAX_RETRY_ATTEMPTS = 5

COLUMNS = [
    ("order_code", "OrderCode"),
    ("status_name", "Status"),
    ("client_id", "ClientID"),
    ("order_value", "OrderValue"),
    ("cod_amount", "CODAmount"),
    ("insurance_value", "InsuranceValue"),
    ("package_value", "PackageValue"),
    ("last_action_at_vn", "LastAction"),
    ("compensation", "Compensation"),
]


def load_config():
    if not os.path.exists(CONFIG_PATH):
        return {"user_agent": "", "token": ""}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"user_agent": "", "token": ""}


def save_config(user_agent, token):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"user_agent": user_agent, "token": token}, f, ensure_ascii=False, indent=2)


def calc_denquahan(order_value, cod_amount, insurance_value, package_value, client_id):
    if package_value > 0:
        return package_value
    if client_id in [3892833, 4447237]:
        if cod_amount > 0:
            return cod_amount
        if order_value <= 1000000:
            return order_value
        return max(1000000, min(30000000, order_value * 0.7))
    if insurance_value != 0:
        return insurance_value
    if order_value <= 1000000:
        return order_value
    val_80 = order_value * 0.8
    return max(1000000, min(14000000, val_80))


def calc_denbosung(order_value, cod_amount, insurance_value, package_value):
    if package_value > 0:
        return package_value
    if cod_amount == 0:
        if insurance_value != 0:
            return insurance_value
        if order_value <= 1000000:
            return order_value
        if order_value * 0.8 <= 1000000:
            return 1000000
        if order_value * 0.8 > 20000000:
            return 14000000
        return 0.8 * order_value
    if cod_amount >= order_value:
        return 0
    if order_value < 1000000:
        return order_value - cod_amount
    if order_value * 0.8 < 1000000:
        return 1000000 - cod_amount
    if order_value * 0.8 <= cod_amount:
        return 0
    if order_value >= 20000000:
        return max(0, 14000000 - cod_amount)
    return 0.8 * order_value - cod_amount


def compute_compensation(status_name, order_value, cod_amount, insurance_value, package_value, client_id):
    if status_name in LOST_STATUSES:
        return calc_denquahan(order_value, cod_amount, insurance_value, package_value, client_id)
    if status_name == DELIVERED:
        return calc_denbosung(order_value, cod_amount, insurance_value, package_value)
    return calc_denquahan(order_value, cod_amount, insurance_value, package_value, client_id)


def fetch_tracking_data(order_code, user_agent, token):
    headers = {
        "User-Agent": user_agent,
        "Token": token,
        "Content-Type": "application/json",
    }
    payload = {"order_code": order_code, "source": "inside_system"}

    wait_seconds = 1
    last_error = None

    for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
        try:
            response = requests.post(TRACKING_URL, json=payload, headers=headers, timeout=10)

            if response.status_code == 429:
                last_error = "Bị giới hạn tần suất (429), đang chờ thử lại"
                time.sleep(min(wait_seconds, 10))
                wait_seconds *= 2
                continue

            response.raise_for_status()
            resp = response.json()
            order_info = resp.get("data", {}).get("order_info", {})
            custom_field = order_info.get("custom_field", {})
            tracking_logs = resp.get("data", {}).get("tracking_logs", [])

            last_action_at_vn = ""
            for log in tracking_logs:
                action_at = log.get("action_at")
                if action_at:
                    utc_time = datetime.fromisoformat(action_at.replace("Z", "+00:00"))
                    last_action_at_vn = utc_time.astimezone(HO_CHI_MINH_TZ).strftime("%Y-%m-%d %H:%M:%S")

            order_value = int(custom_field.get("OrderValue", 0) or 0)
            cod_amount = int(order_info.get("cod_amount", 0) or 0)
            insurance_value = int(order_info.get("insurance_value", 0) or 0)
            package_value = int(custom_field.get("PackageValue", 0) or 0)
            client_id = order_info.get("client_id")
            status_name = order_info.get("status_name", "Not found")

            compensation = compute_compensation(
                status_name, order_value, cod_amount, insurance_value, package_value, client_id
            )

            return {
                "order_code": order_code,
                "status_name": status_name,
                "client_id": client_id,
                "order_value": order_value,
                "cod_amount": cod_amount,
                "insurance_value": insurance_value,
                "package_value": package_value,
                "last_action_at_vn": last_action_at_vn,
                "compensation": round(compensation),
                "error": None,
            }

        except requests.exceptions.RequestException as exc:
            last_error = str(exc)
            if attempt >= MAX_RETRY_ATTEMPTS:
                break
            time.sleep(min(wait_seconds, 10))
            wait_seconds *= 2

    return {
        "order_code": order_code,
        "status_name": "Lỗi",
        "client_id": "",
        "order_value": "",
        "cod_amount": "",
        "insurance_value": "",
        "package_value": "",
        "last_action_at_vn": "",
        "compensation": "",
        "error": last_error or "Không xác định",
    }


class GHNCheckerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("GHN Order Checker")
        self.root.geometry("1180x680")
        self.root.configure(bg=COLOR_BG)

        self.results = []
        self.is_running = False
        self.stop_requested = False

        self.build_style()
        self.build_layout()
        self.load_saved_config()

    def build_style(self):
        style = ttk.Style()
        style.theme_use("clam")

        style.configure(
            "Treeview",
            background=COLOR_SURFACE,
            fieldbackground=COLOR_SURFACE,
            foreground=COLOR_TEXT,
            rowheight=30,
            font=(FONT_FAMILY, 11),
            borderwidth=0,
        )
        style.configure(
            "Treeview.Heading",
            background=COLOR_BLUE,
            foreground="white",
            font=(FONT_FAMILY, 11, "bold"),
            borderwidth=0,
        )
        style.map("Treeview", background=[("selected", "#FBF6EF")], foreground=[("selected", COLOR_TEXT)])

        style.configure("App.TNotebook", background=COLOR_BG, borderwidth=0)
        style.configure(
            "App.TNotebook.Tab",
            background=COLOR_SURFACE,
            foreground=COLOR_MUTED,
            font=(FONT_FAMILY, 11, "bold"),
            padding=(18, 10),
            borderwidth=0,
        )
        style.map(
            "App.TNotebook.Tab",
            background=[("selected", COLOR_ORANGE)],
            foreground=[("selected", "white")],
        )

    def build_layout(self):
        notebook = ttk.Notebook(self.root, style="App.TNotebook")
        notebook.pack(fill="both", expand=True)

        tab_tra_cuu = tk.Frame(notebook, bg=COLOR_BG)
        notebook.add(tab_tra_cuu, text="Tra cứu")

        shell = tk.Frame(tab_tra_cuu, bg=COLOR_BG)
        shell.pack(fill="both", expand=True)

        side = tk.Frame(shell, bg=COLOR_SURFACE, width=320, highlightbackground=COLOR_BORDER, highlightthickness=1)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        main = tk.Frame(shell, bg=COLOR_BG)
        main.pack(side="left", fill="both", expand=True)

        self.build_side_panel(side)
        self.build_main_panel(main)

    def build_side_panel(self, parent):
        pad = {"padx": 18, "pady": (14, 4)}

        tk.Label(parent, text="GHN Order Checker", font=(FONT_FAMILY, 15, "bold"), bg=COLOR_SURFACE, fg=COLOR_TEXT).pack(anchor="w", **pad)
        tk.Label(parent, text="Kiểm tra trạng thái & tính đền bù", font=(FONT_FAMILY, 11), bg=COLOR_SURFACE, fg=COLOR_MUTED).pack(anchor="w", padx=18, pady=(0, 14))

        tk.Label(parent, text="User-Agent", font=(FONT_FAMILY, 11, "bold"), bg=COLOR_SURFACE, fg=COLOR_TEXT).pack(anchor="w", padx=18)
        self.entry_user_agent = tk.Entry(parent, font=(FONT_FAMILY, 10), bg="#FBFAF7", relief="solid", bd=1)
        self.entry_user_agent.pack(fill="x", padx=18, pady=(4, 10))

        tk.Label(parent, text="Token", font=(FONT_FAMILY, 11, "bold"), bg=COLOR_SURFACE, fg=COLOR_TEXT).pack(anchor="w", padx=18)
        self.entry_token = tk.Entry(parent, font=(FONT_FAMILY, 10), bg="#FBFAF7", relief="solid", bd=1, show="•")
        self.entry_token.pack(fill="x", padx=18, pady=(4, 6))

        tk.Button(
            parent, text="💾 Lưu cấu hình", command=self.on_save_config,
            bg="white", fg=COLOR_MUTED, font=(FONT_FAMILY, 10, "bold"),
            relief="solid", bd=1, cursor="hand2", padx=10, pady=6
        ).pack(anchor="w", padx=18, pady=(0, 16))

        tk.Frame(parent, bg=COLOR_BORDER, height=1).pack(fill="x", padx=18, pady=(0, 14))

        tk.Label(parent, text="Danh sách mã đơn", font=(FONT_FAMILY, 11, "bold"), bg=COLOR_SURFACE, fg=COLOR_TEXT).pack(anchor="w", padx=18)
        self.text_codes = tk.Text(parent, font=(FONT_FAMILY, 10), height=12, bg="#FBFAF7", relief="solid", bd=1)
        self.text_codes.pack(fill="both", expand=False, padx=18, pady=(4, 12))

        btn_row = tk.Frame(parent, bg=COLOR_SURFACE)
        btn_row.pack(fill="x", padx=18, pady=(0, 8))

        self.btn_run = tk.Button(
            btn_row, text="▶ Chạy kiểm tra", command=self.on_run_clicked,
            bg=COLOR_ORANGE, fg="white", font=(FONT_FAMILY, 11, "bold"),
            relief="flat", cursor="hand2", padx=14, pady=10
        )
        self.btn_run.pack(side="left", fill="x", expand=True, padx=(0, 6))

        tk.Button(
            btn_row, text="Xóa", command=self.on_clear_clicked,
            bg="white", fg=COLOR_MUTED, font=(FONT_FAMILY, 11, "bold"),
            relief="solid", bd=1, cursor="hand2", padx=14, pady=10
        ).pack(side="left")

        self.label_status = tk.Label(parent, text="", font=(FONT_FAMILY, 10), bg=COLOR_SURFACE, fg=COLOR_MUTED, wraplength=280, justify="left")
        self.label_status.pack(anchor="w", padx=18, pady=(6, 0))

    def build_main_panel(self, parent):
        toolbar = tk.Frame(parent, bg=COLOR_BG)
        toolbar.pack(fill="x", padx=20, pady=(18, 14))

        self.label_summary = tk.Label(toolbar, text="Chưa có kết quả", font=(FONT_FAMILY, 12), bg=COLOR_BG, fg=COLOR_MUTED)
        self.label_summary.pack(side="left")

        tk.Button(
            toolbar, text="📋 Copy kết quả", command=self.on_copy_clicked,
            bg="white", fg=COLOR_MUTED, font=(FONT_FAMILY, 10, "bold"),
            relief="solid", bd=1, cursor="hand2", padx=12, pady=6
        ).pack(side="right", padx=(6, 0))

        tk.Button(
            toolbar, text="Xuất Excel", command=self.on_export_xlsx_clicked,
            bg="white", fg=COLOR_MUTED, font=(FONT_FAMILY, 10, "bold"),
            relief="solid", bd=1, cursor="hand2", padx=12, pady=6
        ).pack(side="right", padx=(6, 0))

        tk.Button(
            toolbar, text="Xuất CSV", command=self.on_export_csv_clicked,
            bg="white", fg=COLOR_MUTED, font=(FONT_FAMILY, 10, "bold"),
            relief="solid", bd=1, cursor="hand2", padx=12, pady=6
        ).pack(side="right")

        table_frame = tk.Frame(parent, bg=COLOR_BG)
        table_frame.pack(fill="both", expand=True, padx=20, pady=(0, 20))

        col_ids = [c[0] for c in COLUMNS]
        self.tree = ttk.Treeview(table_frame, columns=col_ids, show="headings")
        for col_id, col_label in COLUMNS:
            self.tree.heading(col_id, text=col_label)
            width = 160 if col_id in ("order_code", "status_name", "last_action_at_vn") else 110
            self.tree.column(col_id, width=width, anchor="w")

        vsb = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")

    def load_saved_config(self):
        cfg = load_config()
        self.entry_user_agent.insert(0, cfg.get("user_agent", ""))
        self.entry_token.insert(0, cfg.get("token", ""))

    def on_save_config(self):
        save_config(self.entry_user_agent.get().strip(), self.entry_token.get().strip())
        messagebox.showinfo("Đã lưu", "Đã lưu User-Agent & Token vào file cấu hình cạnh script.")

    def on_clear_clicked(self):
        self.text_codes.delete("1.0", "end")
        self.results = []
        for row in self.tree.get_children():
            self.tree.delete(row)
        self.label_summary.config(text="Chưa có kết quả")
        self.label_status.config(text="")

    def parse_codes(self):
        raw = self.text_codes.get("1.0", "end")
        codes = []
        seen = set()
        for line in raw.replace(",", "\n").split("\n"):
            code = line.strip().upper()
            if code and code not in seen:
                seen.add(code)
                codes.append(code)
        return codes

    def on_run_clicked(self):
        if self.is_running:
            return

        user_agent = self.entry_user_agent.get().strip()
        token = self.entry_token.get().strip()
        if not user_agent or not token:
            messagebox.showwarning("Thiếu thông tin", "Vui lòng nhập đầy đủ User-Agent và Token.")
            return

        codes = self.parse_codes()
        if not codes:
            messagebox.showwarning("Thiếu dữ liệu", "Vui lòng nhập ít nhất 1 mã đơn.")
            return

        self.is_running = True
        self.btn_run.config(state="disabled", text="Đang chạy...")
        for row in self.tree.get_children():
            self.tree.delete(row)
        self.results = []

        thread = threading.Thread(target=self.run_check_thread, args=(codes, user_agent, token), daemon=True)
        thread.start()

    def run_check_thread(self, codes, user_agent, token):
        total = len(codes)
        for idx, code in enumerate(codes, start=1):
            start_time = time.time()
            result = fetch_tracking_data(code, user_agent, token)
            self.results.append(result)
            self.root.after(0, self.on_row_ready, result, idx, total)

            elapsed = time.time() - start_time
            remaining_sleep = REQUEST_SLEEP_SECONDS - elapsed
            if remaining_sleep > 0 and idx < total:
                time.sleep(remaining_sleep)

        self.root.after(0, self.on_run_finished, total)

    def on_row_ready(self, result, idx, total):
        values = [result[c[0]] for c in COLUMNS]
        row_id = self.tree.insert("", "end", values=values)
        if result.get("error"):
            self.tree.item(row_id, tags=("error",))
            self.tree.tag_configure("error", background=COLOR_DANGER_BG)
        self.label_status.config(text=f"Đang chạy... {idx}/{total}")

    def on_run_finished(self, total):
        self.is_running = False
        self.btn_run.config(state="normal", text="▶ Chạy kiểm tra")
        error_count = sum(1 for r in self.results if r.get("error"))
        if error_count:
            self.label_status.config(text=f"✅ Hoàn thành! {total} đơn — {error_count} đơn bị lỗi.")
        else:
            self.label_status.config(text=f"✅ Hoàn thành! Đã xử lý {total} đơn.")
        self.label_summary.config(text=f"{total} kết quả")
        messagebox.showinfo("Hoàn thành", f"Đã xử lý xong {total} đơn hàng.\nLỗi: {error_count} đơn.")

    def on_copy_clicked(self):
        if not self.results:
            return
        header = "\t".join(c[1] for c in COLUMNS)
        lines = [header]
        for r in self.results:
            lines.append("\t".join(str(r[c[0]]) for c in COLUMNS))
        self.root.clipboard_clear()
        self.root.clipboard_append("\n".join(lines))
        messagebox.showinfo("Đã copy", "Đã copy kết quả vào clipboard.")

    def on_export_csv_clicked(self):
        if not self.results:
            messagebox.showwarning("Chưa có dữ liệu", "Chưa có kết quả để xuất.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")])
        if not path:
            return
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([c[1] for c in COLUMNS])
            for r in self.results:
                writer.writerow([r[c[0]] for c in COLUMNS])
        messagebox.showinfo("Đã xuất", f"Đã lưu file:\n{path}")

    def on_export_xlsx_clicked(self):
        if not self.results:
            messagebox.showwarning("Chưa có dữ liệu", "Chưa có kết quả để xuất.")
            return
        try:
            from openpyxl import Workbook
        except ImportError:
            messagebox.showerror("Thiếu thư viện", "Cần cài đặt: pip install openpyxl")
            return
        path = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")])
        if not path:
            return
        wb = Workbook()
        ws = wb.active
        ws.append([c[1] for c in COLUMNS])
        for r in self.results:
            ws.append([r[c[0]] for c in COLUMNS])
        wb.save(path)
        messagebox.showinfo("Đã xuất", f"Đã lưu file:\n{path}")


if __name__ == "__main__":
    root = tk.Tk()
    app = GHNCheckerApp(root)
    root.mainloop()
