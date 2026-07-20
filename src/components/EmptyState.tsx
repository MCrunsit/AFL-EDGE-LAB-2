import { Database, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';

interface EmptyStateProps {
  title?: string;
  message?: string;
  showImportLink?: boolean;
  icon?: 'database' | 'warning';
}

export default function EmptyState({
  title = 'No Data Available',
  message = 'Import player and match data to begin analysis.',
  showImportLink = true,
  icon = 'database',
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 bg-gray-800 border border-gray-700 rounded-2xl flex items-center justify-center mb-4">
        {icon === 'database'
          ? <Database className="w-7 h-7 text-gray-600" />
          : <AlertTriangle className="w-7 h-7 text-amber-500/60" />
        }
      </div>
      <h3 className="text-white font-semibold text-lg mb-2">{title}</h3>
      <p className="text-gray-500 text-sm max-w-sm mb-6">{message}</p>
      {showImportLink && (
        <Link
          to="/import"
          className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm hover:bg-emerald-500/20 transition"
        >
          Go to Import Data
        </Link>
      )}
    </div>
  );
}
