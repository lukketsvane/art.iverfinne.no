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

/** 412 cm³ → "412 cm³"; 998600 cm³ → "999 L". */
export function fmtVolume(cm3: number): string {
	return cm3 >= 10000 ? `${(cm3 / 1000).toFixed(0)} L` : `${cm3.toFixed(0)} cm³`;
}

/** ART: the app's volume currency. One ART = 100 L of caulk. */
export const CM3_PER_ART = 100000;
export const USD_PER_ART = 0.67; // display-only novelty rate

export function toArt(cm3: number): number {
	return cm3 / CM3_PER_ART;
}

export function fmtArt(cm3: number): string {
	const art = toArt(cm3);
	return art >= 100 ? art.toFixed(0) : art.toFixed(2);
}

export interface PlacementPose {
	lat: number;
	lon: number;
	alt: number | null;
	heading: number | null;
	accuracy: number | null;
}
