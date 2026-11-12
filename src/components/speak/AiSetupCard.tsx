import { useNavigate } from "react-router-dom";
import { Settings as SettingsIcon } from "lucide-react";

/** AI のキーが無いとき: Gemini（無料枠）のキーの作り方と、設定を開くボタン（AI との会話・「なんて言う？」で使う） */
export default function AiSetupCard({ title = "AI と話すには、Gemini の APIキー（無料）が必要です" }: { title?: string }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-2.5 rounded-2xl bg-violet-50 p-4 text-sm leading-relaxed text-slate-600 ring-1 ring-violet-100">
      <p className="font-bold text-violet-800">{title}</p>
      <p>Google AI Studio のアカウントがあれば、数分で用意できます。課金（請求先アカウント）を設定しなければ、無料枠のまま 0円で使えます。</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-brand-blue underline">
            aistudio.google.com
          </a>{" "}
          を開いて、Google アカウントでログイン
        </li>
        <li>「Get API key」でキーを作り、コピー（AIza で始まる）</li>
        <li>このアプリの設定の「AI」の Gemini の欄に貼り付けて「保存」</li>
      </ol>
      <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
        ⚠ 無料枠では、送った内容と返事が Google の製品改善に使われ、人が読むこともあります。個人情報は書かないでください。
      </p>
      <button type="button" onClick={() => navigate("/settings", { state: { focus: "ai" } })} className="btn-primary min-h-11 w-full">
        <SettingsIcon size={18} aria-hidden />
        設定を開く
      </button>
    </div>
  );
}
