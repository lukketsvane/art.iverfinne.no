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

/** Position on a spot's target image: origin centre, x right, y up, image width = 1. */
export interface SpotXY {
	x: number;
	y: number;
	s: number;
}

export interface Spot {
	id: string;
	creator_id?: string;
	name: string | null;
	lat: number;
	lon: number;
	distance_m?: number;
	accuracy_m?: number | null;
	image_path: string;
	target_path: string;
	tag_count: number;
}

export interface SpotTag {
	id: string;
	creator_id: string;
	model_url: string;
	size_class: SizeClass;
	spot_xy: SpotXY | null;
	appraisals: number;
	appraised: boolean;
	created_at: string;
}

/** Tag size on a wall, in units of target-image width. */
export const SPOT_SIZE_SCALE: Record<SizeClass, number> = { s: 0.15, m: 0.28, l: 0.5 };

export interface PlacementPose {
	lat: number;
	lon: number;
	alt: number | null;
	heading: number | null;
	accuracy: number | null;
}
