import { AlertTriangle } from "lucide-react";

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="error-notice" role="alert">
      <AlertTriangle size={19} />
      <span>{message}</span>
    </div>
  );
}
