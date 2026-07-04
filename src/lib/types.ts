export type SizeClass = 's' | 'm' | 'l';

export const SIZE_COST: Record<SizeClass, number> = { s: 50, m: 125, l: 250 };
export const SIZE_SCALE: Record<SizeClass, number> = { s: 0.5, m: 1, l: 2 };

export interface Profile {
	id: string;
	handle: string | null;
	total_volume: number;
	used_volume: number;
}

export interface NearbyTag {
	id: string;
	creator_id: string;
	lat: number;
	lon: number;
	alt: number;
	heading: number | null;
	accuracy_m: number | null;
	model_url: string;
	size_class: SizeClass;
	distance_m: number;
	appraisals: number;
	appraised: boolean;
	created_at: string;
}

export interface PlacementPose {
	lat: number;
	lon: number;
	alt: number | null;
	heading: number | null;
	accuracy: number | null;
}
