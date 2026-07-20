interface StatBadgeProps {
  label: string;
  value: number | string;
  sub?: string;
  color?: 'emerald' | 'cyan' | 'amber' | 'red' | 'blue' | 'gray';
  size?: 'sm' | 'md' | 'lg';
}

const colorMap = {
  emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
  cyan: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400',
  amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  red: 'bg-red-500/10 border-red-500/20 text-red-400',
  blue: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  gray: 'bg-gray-800 border-gray-700 text-gray-400',
};

export default function StatBadge({ label, value, sub, color = 'gray', size = 'md' }: StatBadgeProps) {
  return (
    <div className={`border rounded-lg px-3 ${size === 'sm' ? 'py-2' : 'py-3'} ${colorMap[color]}`}>
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-bold ${size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl'} text-white`}>
        {typeof value === 'number' ? value.toFixed(1) : value}
      </p>
      {sub && <p className="text-xs mt-0.5 opacity-70">{sub}</p>}
    </div>
  );
}
